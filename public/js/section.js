/* global Ros, RosNav, io */
// Shared plumbing for planner section pages: event header, data loading, live refresh.
const RosSection = (() => {
  const { token, mode } = RosNav;
  const api = (method, path, body) => Ros.api(method, `${RosNav.api}${path}`, body).catch((err) => {
    Ros.toast(navigator.onLine ? err.message : "You're offline. Changes need a connection.");
    throw err;
  });

  // load() fetches this page's data and render() draws it; both re-run when another screen changes `topic`.
  function start({ section, topics, load }) {
    RosNav.mount(section);
    Ros.api('GET', RosNav.api).then(({ event }) => {
      document.getElementById('ev-name').textContent = event.name;
      document.getElementById('ev-sub').textContent = [Ros.fmtDate(event.date), event.venue].filter(Boolean).join(' · ');
      document.title = `${event.name} · Run of Show`;
    }).catch((err) => { document.getElementById('ev-name').textContent = err.status === 404 ? 'Event not found' : 'Could not load'; });
    let pending = null;
    const refresh = () => { clearTimeout(pending); pending = setTimeout(load, 150); };
    const socket = io({ auth: { p: { planner: token }, c: { couple: token }, v: { vendor: token } }[mode] });
    socket.on('changed', (topic) => { if (topics.includes(topic)) refresh(); });
    socket.on('connect', refresh);
    load();
    Ros.registerSW();
    return refresh;
  }

  // Wires a <dialog> whose form has value="save" / "delete" buttons.
  function dialog(id, { fill, save, remove }) {
    const dlg = document.getElementById(id);
    const form = dlg.querySelector('form');
    let current = null;
    dlg.addEventListener('close', async () => {
      try {
        if (dlg.returnValue === 'delete' && current && remove) await remove(current);
        if (dlg.returnValue === 'save') await save(form, current);
      } catch { /* toast already shown */ }
    });
    return (item) => {
      current = item;
      form.reset();
      fill(form, item);
      const del = form.querySelector('[value=delete]');
      if (del) del.classList.toggle('hidden', !item);
      dlg.showModal();
    };
  }

  return { token, mode, api, start, dialog };
})();
