(() => {
  document.querySelectorAll('[data-site-chrome-search]').forEach(form => {
    const input = form.querySelector('input[name="search"]');
    const list = form.querySelector('[role="listbox"]');
    if (!(input instanceof HTMLInputElement) || !(list instanceof HTMLElement)) return;

    let timer = 0;
    let controller = null;
    let suggestions = [];
    let activeIndex = -1;
    let requestVersion = 0;
    const footer = document.createElement('a');
    footer.className = 'siteChromeSsrSearchAll';
    list.insertAdjacentElement('afterend', footer);

    const close = () => {
      list.hidden = true;
      footer.hidden = true;
      activeIndex = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    };
    const destination = item => item.type === 'Product' ? `/products/${encodeURIComponent(item.id)}` : `/store/${encodeURIComponent(item.slug)}`;
    const fullSearch = () => {
      const url = new URL(form.action, window.location.origin);
      url.searchParams.set('search', input.value.trim());
      footer.href = `${url.pathname}${url.search}`;
      footer.textContent = `View all results for “${input.value.trim()}”`;
    };
    const status = (message, failed = false) => {
      list.replaceChildren();
      suggestions = [];
      activeIndex = -1;
      const paragraph = document.createElement('p');
      paragraph.className = 'siteChromeSsrSearchStatus';
      paragraph.setAttribute('role', 'status');
      paragraph.textContent = message;
      list.append(paragraph);
      fullSearch();
      footer.hidden = failed || input.value.trim().length < 2;
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    };
    const updateActive = () => {
      list.querySelectorAll('[role="option"]').forEach((option, index) => option.setAttribute('aria-selected', String(index === activeIndex)));
      if (activeIndex >= 0) input.setAttribute('aria-activedescendant', `site-chrome-ssr-option-${activeIndex}`);
      else input.removeAttribute('aria-activedescendant');
    };
    const render = result => {
      list.replaceChildren();
      suggestions = [...(result.products || []).filter(item => item.type === 'Product'), ...(result.stores || []).filter(item => item.type === 'Store')].slice(0, 6);
      activeIndex = -1;
      if (!suggestions.length) {
        status('No matching products or stores. Try another search.');
        return;
      }
      suggestions.forEach((item, index) => {
        const link = document.createElement('a');
        link.className = 'siteChromeSsrSearchSuggestion';
        link.href = destination(item);
        link.id = `site-chrome-ssr-option-${index}`;
        link.setAttribute('role', 'option');
        link.setAttribute('aria-selected', 'false');
        const type = document.createElement('span');
        type.className = 'siteChromeSsrSearchSuggestionType';
        type.textContent = item.type;
        const name = document.createElement('strong');
        name.textContent = item.name;
        const detail = document.createElement('small');
        detail.textContent = item.type === 'Product'
          ? [item.store && item.store.name, item.category && item.category.name].filter(Boolean).join(' · ') || 'Marketplace product'
          : item.description || 'Marketplace store';
        link.append(type, name, detail);
        link.addEventListener('mouseenter', () => { activeIndex = index; updateActive(); });
        link.addEventListener('click', close);
        list.append(link);
      });
      fullSearch();
      footer.hidden = false;
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    };

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', list.id || 'site-chrome-ssr-suggestions');
    list.id = list.id || 'site-chrome-ssr-suggestions';
    close();
    input.addEventListener('input', () => {
      window.clearTimeout(timer);
      controller?.abort();
      const query = input.value.trim();
      if (query.length < 2) { close(); list.replaceChildren(); footer.hidden = true; return; }
      const version = ++requestVersion;
      timer = window.setTimeout(async () => {
        controller = new AbortController();
        status('Searching products and stores…');
        try {
          const response = await fetch(`/api/marketplace/search?q=${encodeURIComponent(query)}&limit=3`, { credentials: 'omit', cache: 'no-store', signal: controller.signal });
          if (!response.ok) throw new Error('Search unavailable');
          const result = await response.json();
          if (version === requestVersion && input.value.trim() === query) render(result);
        } catch (error) {
          if (version === requestVersion && error.name !== 'AbortError') status('Suggestions are temporarily unavailable. Press Search to try the full catalog.', true);
        }
      }, 180);
    });
    input.addEventListener('focus', () => {
      if (input.value.trim().length >= 2 && list.childElementCount) { list.hidden = false; footer.hidden = false; input.setAttribute('aria-expanded', 'true'); }
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') { close(); return; }
      if (!suggestions.length) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); activeIndex = (activeIndex + 1) % suggestions.length; updateActive(); }
      if (event.key === 'ArrowUp') { event.preventDefault(); activeIndex = (activeIndex - 1 + suggestions.length) % suggestions.length; updateActive(); }
      if (event.key === 'Enter' && activeIndex >= 0) { event.preventDefault(); window.location.assign(destination(suggestions[activeIndex])); }
    });
    form.addEventListener('submit', event => {
      if (activeIndex >= 0 && suggestions[activeIndex]) { event.preventDefault(); window.location.assign(destination(suggestions[activeIndex])); }
    });
    document.addEventListener('pointerdown', event => { if (!form.contains(event.target)) close(); });
  });
})();
