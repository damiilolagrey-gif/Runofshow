/* global Ros */
// Section tabs plus the "Share & settings" dialog. The planner (/p/), the couple (/c/) and a vendor
// trusted with seating (/v/) each see their own tabs over the same pages.
const RosNav = (() => {
  const [, mode, token] = location.pathname.split('/');
  const base = `/${mode}/${token}`;
  const api = `/api/${mode}/${token}`;
  const sections = {
    p: [['', 'Timeline'], ['guests', 'Guests'], ['inbox', 'Messages'], ['tables', 'Table plan'], ['asoebi', 'Aso-ebi'], ['money', 'Payments & budget'], ['progress', 'Couple’s progress'], ['recap', 'Recap']],
    c: [['', 'Overview'], ['guests', 'Guests & RSVPs'], ['inbox', 'Messages'], ['tables', 'Table plan'], ['asoebi', 'Aso-ebi'], ['recap', 'Recap']],
    v: [['', '← My cues'], ['tables', 'Table plan']],
  }[mode];

  function mount(active) {
    const nav = document.getElementById('sections');
    nav.innerHTML = (mode === 'p' ? '<a class="navlink" href="/dashboard" title="All my events">← My events</a>' : '')
      + sections.map(([slug, label]) => `<a class="navlink${slug === active ? ' on' : ''}" href="${base}${slug ? `/${slug}` : ''}">${label}</a>`).join('')
      + (mode === 'v' ? '' : '<button class="navlink share" id="share-btn" type="button">Share &amp; settings</button>');
    if (mode === 'v') return;
    document.body.insertAdjacentHTML('beforeend', `
      <dialog id="share-dlg"><form method="dialog">
        <h3>Links for this event</h3>
        <div class="links" id="share-links"></div>
        <h3 style="margin-top:18px">Settings</h3>
        <label class="inline"><input type="checkbox" id="set-rsvp"> Anyone with the RSVP link can RSVP</label>
        <div class="field"><label for="set-info">Information for guests</label>
          <textarea id="set-info" rows="3" placeholder="Dress code: emerald and gold. Parking at the back gate. Reception starts 2pm prompt."></textarea>
          <div class="muted small" style="margin-top:4px">Shown on every invite. The WhatsApp RSVP assistant uses it to answer guests’ questions.</div></div>
        <div class="field"><label for="set-pay">How aso-ebi buyers pay you</label>
          <textarea id="set-pay" placeholder="GTBank 0123456789 · Adetola Events. Use your name as the narration."></textarea></div>
        <div class="foot"><button class="btn" value="cancel">Close</button><button class="btn primary" value="save">Save settings</button></div>
      </form></dialog>`);
    const dlg = document.getElementById('share-dlg');
    document.getElementById('share-btn').addEventListener('click', async () => {
      const { event: e } = await Ros.api('GET', api);
      const o = location.origin;
      const link = (label, url, help) => `<div class="linkrow"><div class="grow"><strong>${label}</strong><div class="muted small">${help}</div></div>
        <button class="btn sm" type="button" data-copy="${url}">Copy</button>
        <a class="btn sm" target="_blank" rel="noopener" href="${Ros.waLink('', `${label} for ${e.name}: ${url}`)}">WhatsApp</a></div>`;
      document.getElementById('share-links').innerHTML = [
        mode === 'p' && link('Couple’s page', `${o}/c/${e.couple_token}`, 'For the couple: progress, guests and RSVPs, table plan, aso-ebi and budget. They rate vendors here after the event.'),
        link('RSVP and aso-ebi page', `${o}/e/${e.public_token}`, 'For family WhatsApp groups. Guests RSVP and order aso-ebi.'),
        link('Usher gate scanner', `${o}/gate/${e.gate_token}`, 'For ushers’ phones. Scans guest QR codes at the gate.'),
        mode === 'p' && link('Planner (you)', `${o}/p/${token}`, 'Full control. Keep this one private.'),
        mode === 'c' && link('Couple’s page (you)', `${o}/c/${token}`, 'Your page. Share it only with whoever is helping you run the guest list.'),
      ].filter(Boolean).join('');
      document.getElementById('set-rsvp').checked = Boolean(e.rsvp_open);
      document.getElementById('set-info').value = e.guest_info || '';
      document.getElementById('set-pay').value = e.pay_details || '';
      dlg.showModal();
    });
    dlg.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-copy]');
      if (b) Ros.copy(b.dataset.copy);
    });
    dlg.addEventListener('close', async () => {
      if (dlg.returnValue !== 'save') return;
      await Ros.api('PATCH', `${api}/guest-settings`, {
        rsvp_open: document.getElementById('set-rsvp').checked, guest_info: document.getElementById('set-info').value, pay_details: document.getElementById('set-pay').value,
      });
      Ros.toast('Settings saved');
    });
  }

  return { mode, token, base, api, mount };
})();
