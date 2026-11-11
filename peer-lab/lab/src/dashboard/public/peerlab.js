/* Shared navigation. Existing tables, forms, and shortcuts remain intact. */
(() => {
  function select() {
    const view = location.pathname.startsWith('/map/') ? 'map' : (location.hash.slice(1) || 'overview');
    document.querySelectorAll('.peerlab-nav a').forEach(a => {
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    const section = document.getElementById(location.hash.slice(1));
    if (section) {
      if (section.tagName === 'DETAILS') section.open = true;
      section.classList.remove('folded');
      section.querySelector('.fold-title')?.setAttribute('aria-expanded', 'true');
      requestAnimationFrame(() => section.scrollIntoView({ block: 'start' }));
    }
  }
  addEventListener('hashchange', select);
  addEventListener('load', select);
  select();
})();
