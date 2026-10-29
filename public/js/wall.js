/* global Ros, io */
// The live wall on a TV: loops the guests' photos and videos, and a new one jumps to the front of the queue.
(() => {
  const token = location.pathname.split('/').pop();
  const api = `/api/wall/${token}`;
  const $ = (id) => document.getElementById(id);
  const SECONDS = 7;
  let items = [];
  let queue = []; // new arrivals, shown next
  let i = 0;
  let timer = null;

  const fileUrl = (m) => `${api}/file/${m.id}`;

  function show(m) {
    clearTimeout(timer);
    if (!m) { $('empty').classList.remove('hidden'); timer = setTimeout(next, 3000); return; }
    $('empty').classList.add('hidden');
    const slide = document.createElement('figure');
    slide.className = 'wall-slide';
    const media = m.kind === 'video' ? Object.assign(document.createElement('video'), { src: fileUrl(m), muted: true, autoplay: true, playsInline: true }) : Object.assign(document.createElement('img'), { src: fileUrl(m), alt: '' });
    slide.append(media);
    if (m.guest_name) slide.insertAdjacentHTML('beforeend', `<figcaption>📸 ${Ros.esc(m.guest_name)}</figcaption>`);
    $('stage').append(slide);
    requestAnimationFrame(() => slide.classList.add('in'));
    for (const old of [...$('stage').querySelectorAll('.wall-slide')].slice(0, -1)) { old.classList.remove('in'); setTimeout(() => old.remove(), 900); }
    // Videos play to the end (up to 30s); photos stay SECONDS.
    if (m.kind === 'video') {
      let done = false;
      const go = () => { if (!done) { done = true; next(); } };
      media.addEventListener('ended', go);
      media.addEventListener('error', go);
      timer = setTimeout(go, 30000);
    } else {
      timer = setTimeout(next, SECONDS * 1000);
    }
  }
  function next() {
    if (queue.length) return show(queue.shift());
    if (!items.length) return show(null);
    i = (i + 1) % items.length;
    show(items[i]);
  }

  async function load(start) {
    const d = await Ros.api('GET', api);
    $('names').textContent = d.couple_names || d.event.name;
    $('event').textContent = [d.couple_names ? d.event.name : '', Ros.fmtDate(d.event.date)].filter(Boolean).join(' · ');
    document.title = `${d.couple_names || d.event.name} · Live wall`;
    $('qr').src = `${api}/qr.svg`;
    items = d.items;
    $('count').textContent = items.length ? `${items.length} shared so far` : '';
    if (start) { i = -1; next(); }
  }
  load(true).catch(() => { $('names').textContent = 'This wall link is not valid'; });

  const socket = io({ auth: { wall: token } });
  socket.on('moment', (m) => {
    items.unshift(m);
    i += 1; // keep the loop position steady
    queue.push(m);
    $('count').textContent = `${items.length} shared so far`;
    if (items.length === 1) next();
  });
  socket.on('wall-changed', () => load(false));
  $('fs').addEventListener('click', () => document.documentElement.requestFullscreen?.());
  document.addEventListener('fullscreenchange', () => $('fs').classList.toggle('hidden', Boolean(document.fullscreenElement)));
})();
