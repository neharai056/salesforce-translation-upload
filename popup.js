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
  chrome.tabs.create({ url: chrome.runtime.getURL(`matrix/matrix.html?host=${encodeURIComponent(host)}`) });
});
