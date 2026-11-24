// Accessible combobox: suggestions as you type, arrow keys to move, Enter to
// pick, Escape to close. Stale requests are cancelled so results never jump.

export function attachAutocomplete(input, list, fetchSuggestions, { delay = 150 } = {}) {
  let timer = null;
  let controller = null;
  let items = [];
  let active = -1;
  let seq = 0;

  const open = () => {
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const highlight = (i) => {
    active = i;
    [...list.children].forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
    if (i >= 0) {
      const li = list.children[i];
      input.setAttribute('aria-activedescendant', li.id);
      li.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };

  const choose = (i) => {
    const item = items[i];
    if (!item) return;
    input.value = item.title;
    close();
    input.dispatchEvent(new CustomEvent('pick', { detail: item }));
  };

  const render = () => {
    list.replaceChildren(
      ...items.map((item, i) => {
        const li = document.createElement('li');
        li.id = `${list.id}-${i}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        const t = document.createElement('span');
        t.className = 'opt-title';
        t.textContent = item.title;
        li.append(t);
        if (item.description) {
          const d = document.createElement('span');
          d.className = 'opt-desc';
          d.textContent = item.description;
          li.append(d);
        }
        // mousedown so the input doesn't blur (and close the list) first
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          choose(i);
        });
        return li;
      }),
    );
    if (items.length) open();
    else close();
  };

  const lookup = () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) {
      controller?.abort();
      items = [];
      render();
      return;
    }
    timer = setTimeout(async () => {
      controller?.abort();
      controller = new AbortController();
      const mine = ++seq;
      try {
        const res = await fetchSuggestions(q, controller.signal);
        if (mine !== seq || document.activeElement !== input) return;
        items = res;
        render();
      } catch {
        /* network hiccups just mean no suggestions */
      }
    }, delay);
  };

  input.addEventListener('input', lookup);
  input.addEventListener('focus', () => items.length && input.value.trim() && open());
  input.addEventListener('blur', () => setTimeout(close, 0));
  input.addEventListener('keydown', (e) => {
    if (list.hidden) {
      if (e.key === 'ArrowDown' && items.length) {
        open();
        highlight(0);
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      highlight((active + 1) % items.length);
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      highlight(active <= 0 ? items.length - 1 : active - 1);
      e.preventDefault();
    } else if (e.key === 'Enter' && active >= 0) {
      choose(active);
      e.preventDefault();
    } else if (e.key === 'Escape') {
      close();
      e.preventDefault();
    } else if (e.key === 'Tab') {
      close();
    }
  });

  return {
    close,
    cancel() {
      clearTimeout(timer);
      controller?.abort();
      seq++;
      items = [];
      close();
    },
  };
}
