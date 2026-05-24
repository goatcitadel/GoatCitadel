// Critique toggle + tiny shared behaviors for the mockup deck.
(() => {
  const doc = globalThis.document;
  const storage = globalThis.localStorage;
  if (!doc || !storage) return;

  const STORAGE = 'mc-mockup-critique';
  const saved = storage.getItem(STORAGE);
  if (saved === 'off') doc.body.classList.add('critique-off');

  doc.addEventListener('click', (e) => {
    const t = e.target.closest('[data-critique-toggle]');
    if (!t) return;
    e.preventDefault();
    doc.body.classList.toggle('critique-off');
    const off = doc.body.classList.contains('critique-off');
    t.querySelector('[data-critique-label]')?.replaceChildren(
      doc.createTextNode(off ? 'Show critique' : 'Critique on'),
    );
    storage.setItem(STORAGE, off ? 'off' : 'on');
  });

  // Tab interactions (purely visual swap)
  doc.querySelectorAll('[data-tabs]').forEach((group) => {
    group.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  });
})();
