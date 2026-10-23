for (const button of document.querySelectorAll('.tab')) {
  button.addEventListener('click', () => {
    const name = button.dataset.page;
    document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab === button));
    document.querySelectorAll('.page').forEach(page => page.classList.toggle('active', page.id === name));
  });
}

const updateButton = document.querySelector('#updateButton');
const updateStatus = document.querySelector('#updateStatus');
let currentUpdateState = 'idle';

function renderUpdateStatus(status) {
  if (!status) return;
  currentUpdateState = status.state || 'idle';
  updateStatus.textContent = status.message || 'Update status unavailable.';
  updateButton.disabled = ['checking', 'downloading'].includes(currentUpdateState);
  updateButton.textContent = currentUpdateState === 'downloaded' ? 'Restart to update' : 'Check for updates';
  updateButton.setAttribute('aria-label', updateButton.textContent);
}

if (window.maazUpdates) {
  window.maazUpdates.onStatus(renderUpdateStatus);
  window.maazUpdates.getStatus().then(renderUpdateStatus).catch(() => {
    updateStatus.textContent = 'Update status unavailable.';
  });
  updateButton.addEventListener('click', async () => {
    if (currentUpdateState === 'downloaded') {
      await window.maazUpdates.install();
      return;
    }
    await window.maazUpdates.check();
  });
}
