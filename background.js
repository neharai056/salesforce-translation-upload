// background.js
// Service worker: owns all Salesforce API access (Tooling REST + Metadata SOAP).
// The matrix UI (matrix.js) never talks to Salesforce directly - it messages this file.

const API_VERSION = '61.0';

let fflateLib = null;

async function ensureFflate() {
  if (fflateLib) return fflateLib;

  const url = chrome.runtime.getURL('lib/fflate.min.js');
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load fflate from ${url}: ${response.status}`);
  }

  const source = await response.text();
  const previous = globalThis.fflate;
  eval(source);
  const loaded = globalThis.fflate || previous;

  if (!loaded || typeof loaded.unzipSync !== 'function' || typeof loaded.zipSync !== 'function') {
    throw new Error('fflate did not initialize correctly');
  }

  fflateLib = loaded;
  return fflateLib;
}

// ---------- Session discovery ----------
// Reads the 'sid' cookie for whatever org host the user opened the extension from.
async function getSession(host) {
  const cookie = await chrome.cookies.get({ url: `https://${host}`, name: 'sid' });
  if (!cookie) {
    throw new Error(`No active Salesforce session found for ${host}. Open Setup in that org first, then reopen the matrix.`);
  }
  return { host, sessionId: cookie.value };
}

// ---------- Tooling API (REST) - default-language values ----------
async function toolingQuery(session, soql) {
  const url = `https://${session.host}/services/data/v${API_VERSION}/tooling/query/?q=${encodeURIComponent(soql)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${session.sessionId}` }
  });
  if (!res.ok) throw new Error(`Tooling query failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.records || [];
}

async function getCustomLabels(session) {
  return toolingQuery(session,
    "SELECT Id, Name, MasterLabel, Value, Category FROM ExternalString ORDER BY Name"
  );
}

async function getValidationRules(session) {
  return toolingQuery(session,
    "SELECT Id, ValidationName, Active, ErrorMessage, EntityDefinition.QualifiedApiName FROM ValidationRule ORDER BY EntityDefinition.QualifiedApiName, ValidationName"
  );
}

// ---------- Metadata API (SOAP) - translated values ----------
function soapEnvelope(sessionId, bodyXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <soapenv:Header>
    <met:SessionHeader><met:sessionId>${sessionId}</met:sessionId></met:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>${bodyXml}</soapenv:Body>
</soapenv:Envelope>`;
}

async function soapCall(session, soapAction, bodyXml) {
  const url = `https://${session.host}/services/Soap/m/${API_VERSION}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=UTF-8',
      SOAPAction: soapAction
    },
    body: soapEnvelope(session.sessionId, bodyXml)
  });
  const text = await res.text();
  if (!res.ok) {
    const errorText = text || 'Unknown SOAP error';
    if (errorText.includes('Cannot use: Translations in this organization')) {
      throw new Error('This org does not support Translation metadata operations.');
    }
    throw new Error(`Metadata SOAP call failed (${res.status}): ${errorText}`);
  }
  return new DOMParser().parseFromString(text, 'text/xml');
}

function textOf(doc, tagName) {
  const el = doc.getElementsByTagName(tagName)[0];
  return el ? el.textContent : null;
}
function allOf(doc, tagName) {
  return Array.from(doc.getElementsByTagName(tagName));
}

// Discover active Translation Workbench languages by listing existing .translation files.
async function listTranslationLanguages(session) {
  const body = `<met:listMetadata xmlns:met="http://soap.sforce.com/2006/04/metadata">
    <met:queries><met:type>Translations</met:type></met:queries>
    <met:asOfVersion>${API_VERSION}</met:asOfVersion>
  </met:listMetadata>`;
  const doc = await soapCall(session, '""', body);
  return allOf(doc, 'result')
    .map(r => r.getElementsByTagName('fullName')[0]?.textContent)
    .filter(Boolean); // e.g. ['en_US', 'fr', 'ja']
}

// Submit a retrieve request for the Translations metadata of given languages, poll until done, return { lang: xmlString }.
async function retrieveTranslations(session, languages) {
  const members = languages.map(l => `<met:members>${l}</met:members>`).join('');
  const body = `<met:retrieve xmlns:met="http://soap.sforce.com/2006/04/metadata">
    <met:retrieveRequest>
      <met:apiVersion>${API_VERSION}</met:apiVersion>
      <met:singlePackage>true</met:singlePackage>
      <met:unpackaged>
        <met:types><met:members>*</met:members><met:name>Translations</met:name></met:types>
        <met:version>${API_VERSION}</met:version>
      </met:unpackaged>
    </met:retrieveRequest>
  </met:retrieve>`;
  const submitDoc = await soapCall(session, '""', body);
  const jobId = textOf(submitDoc, 'id');
  if (!jobId) throw new Error('Retrieve submit did not return a job id.');

  // Poll
  let zipBase64 = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const statusBody = `<met:checkRetrieveStatus xmlns:met="http://soap.sforce.com/2006/04/metadata">
      <met:asyncProcessId>${jobId}</met:asyncProcessId>
      <met:includeZip>true</met:includeZip>
    </met:checkRetrieveStatus>`;
    const statusDoc = await soapCall(session, '""', statusBody);
    const done = textOf(statusDoc, 'done');
    if (done === 'true') {
      zipBase64 = textOf(statusDoc, 'zipFile');
      break;
    }
  }
  if (!zipBase64) throw new Error('Retrieve timed out after ~60s.');

  // Unzip in the service worker using fflate (vendored in lib/fflate.min.js)
  const fflate = await ensureFflate();
  const zipBytes = Uint8Array.from(atob(zipBase64), c => c.charCodeAt(0));
  const files = fflate.unzipSync(zipBytes);
  const result = {};
  const decoder = new TextDecoder();
  for (const [path, bytes] of Object.entries(files)) {
    const m = path.match(/translations\/([^/]+)\.translation$/);
    if (m) result[m[1]] = decoder.decode(bytes);
  }
  return result; // { en_US: '<Translations>...</Translations>', fr: '...' }
}

// Deploy edited translation XML files back. `edited` is { lang: xmlString }.
async function deployTranslations(session, edited) {
  const encoder = new TextEncoder();
  const fflate = await ensureFflate();
  const zipInput = {
    'unpackaged/package.xml': encoder.encode(
      `<?xml version="1.0" encoding="UTF-8"?><Package xmlns="http://soap.sforce.com/2006/04/metadata">
        <types><members>*</members><name>Translations</name></types>
        <version>${API_VERSION}</version></Package>`
    )
  };
  for (const [lang, xml] of Object.entries(edited)) {
    zipInput[`unpackaged/translations/${lang}.translation`] = encoder.encode(xml);
  }
  const zipped = fflate.zipSync(zipInput);
  let binary = '';
  zipped.forEach(b => (binary += String.fromCharCode(b)));
  const zipBase64 = btoa(binary);

  const body = `<met:deploy xmlns:met="http://soap.sforce.com/2006/04/metadata">
    <met:ZipFile>${zipBase64}</met:ZipFile>
    <met:DeployOptions><met:singlePackage>true</met:singlePackage><met:rollbackOnError>true</met:rollbackOnError></met:DeployOptions>
  </met:deploy>`;
  const submitDoc = await soapCall(session, '""', body);
  const jobId = textOf(submitDoc, 'id');
  if (!jobId) throw new Error('Deploy submit did not return a job id.');

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const statusBody = `<met:checkDeployStatus xmlns:met="http://soap.sforce.com/2006/04/metadata">
      <met:asyncProcessId>${jobId}</met:asyncProcessId>
      <met:includeDetails>true</met:includeDetails>
    </met:checkDeployStatus>`;
    const statusDoc = await soapCall(session, '""', statusBody);
    const done = textOf(statusDoc, 'done');
    if (done === 'true') {
      const success = textOf(statusDoc, 'success');
      if (success === 'true') return { success: true };
      const messages = allOf(statusDoc, 'componentFailures').map(f => textOf.call(null, { getElementsByTagName: t => f.getElementsByTagName(t) }, 'problem'));
      return { success: false, errors: messages };
    }
  }
  throw new Error('Deploy timed out after ~60s.');
}

// ---------- Message router ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const session = msg.host ? await getSession(msg.host) : null;
      switch (msg.type) {
        case 'GET_SESSION':
          sendResponse({ ok: true, data: session });
          break;
        case 'GET_LABELS':
          sendResponse({ ok: true, data: await getCustomLabels(session) });
          break;
        case 'GET_VALIDATION_RULES':
          sendResponse({ ok: true, data: await getValidationRules(session) });
          break;
        case 'LIST_LANGUAGES':
          sendResponse({ ok: true, data: await listTranslationLanguages(session) });
          break;
        case 'RETRIEVE_TRANSLATIONS':
          sendResponse({ ok: true, data: await retrieveTranslations(session, msg.languages) });
          break;
        case 'DEPLOY_TRANSLATIONS':
          sendResponse({ ok: true, data: await deployTranslations(session, msg.edited) });
          break;
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${msg.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // keep the message channel open for async sendResponse
});

