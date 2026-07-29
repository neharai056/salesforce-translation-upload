const statusEl = document.getElementById('status');
const btn = document.getElementById('launch');

btn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;
  let host;
  try {
    host = new URL(tab.url).host;
  } catch {
    statusEl.textContent = 'Could not read the current tab URL.';
    return;
  }
  const isSalesforceHost = /(^|\.)((salesforce\.com|force\.com|salesforce-setup\.com|my\.salesforce\.com|my\.salesforce-setup\.com))$/.test(host);
  if (!isSalesforceHost) {
    statusEl.textContent = 'Open a Salesforce tab (Setup, Lightning, etc.) first.';
    return;
  }

  statusEl.textContent = 'Checking Salesforce session…';
  try {
    const session = await chrome.runtime.sendMessage({ host, type: 'GET_SESSION' });
    if (!session?.ok || !session?.data?.sessionId) {
      statusEl.textContent = 'Unable to read a valid Salesforce session from this tab. Open a logged-in org tab and try again.';
      return;
    }
  } catch (e) {
    statusEl.textContent = 'Unable to reach the Salesforce session service. Reload the extension and try again.';
    return;
  }

  chrome.tabs.create({ url: chrome.runtime.getURL(`matrix/matrix.html?host=${encodeURIComponent(host)}`) });
});
