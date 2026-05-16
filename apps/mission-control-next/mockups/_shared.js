// Critique toggle + tiny shared behaviors for the mockup deck.
(() => {
  const STORAGE = 'mc-mockup-critique';
  const saved = localStorage.getItem(STORAGE);
  if (saved === 'off') document.body.classList.add('critique-off');

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-critique-toggle]');
    if (!t) return;
    e.preventDefault();
    document.body.classList.toggle('critique-off');
    const off = document.body.classList.contains('critique-off');
    t.querySelector('[data-critique-label]')?.replaceChildren(
      document.createTextNode(off ? 'Show critique' : 'Critique on'),
    );
    localStorage.setItem(STORAGE, off ? 'off' : 'on');
  });

  // Tab interactions (purely visual swap)
  document.querySelectorAll('[data-tabs]').forEach((group) => {
    group.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  });
})();
