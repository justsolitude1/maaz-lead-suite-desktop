for (const button of document.querySelectorAll('.tab')) {
  button.addEventListener('click', () => {
    const name = button.dataset.page;
    document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab === button));
    document.querySelectorAll('.page').forEach(page => page.classList.toggle('active', page.id === name));
  });
}
