/* global Ros */
// Planner section tabs plus the "Share & settings" dialog, shared by every planner page.
const RosNav = (() => {
  const token = location.pathname.split('/')[2];
  const sections = [['', 'Timeline'], ['guests', 'Guests'], ['asoebi', 'Aso-ebi'], ['money', 'Payments & budget']];

  function mount(active) {
    const nav = document.getElementById('sections');
    nav.innerHTML = '<a class="navlink" href="/dashboard" title="All my events">← My events</a>' + sections.map(([slug, label]) => `<a class="navlink${slug === active ? ' on' : ''}" href="/p/${token}${slug ? `/${slug}` : ''}">${label}</a>`).join('')
      + '<button class="navlink share" id="share-btn" type="button">Share &amp; settings</button>';
    document.body.insertAdjacentHTML('beforeend', `
      <dialog id="share-dlg"><form method="dialog">
        <h3>Links for this event</h3>
        <div class="links" id="share-links"></div>
        <h3 style="margin-top:18px">Settings</h3>
        <label class="inline"><input type="checkbox" id="set-rsvp"> Anyone with the RSVP link can RSVP</label>
        <div class="field"><label for="set-pay">How aso-ebi buyers pay you</label>
          <textarea id="set-pay" placeholder="GTBank 0123456789 · Adetola Events. Use your name as the narration."></textarea></div>
        <div class="foot"><button class="btn" value="cancel">Close</button><button class="btn primary" value="save">Save settings</button></div>
      </form></dialog>`);
    const dlg = document.getElementById('share-dlg');
    document.getElementById('share-btn').addEventListener('click', async () => {
      const { event: e } = await Ros.api('GET', `/api/p/${token}`);
      const o = location.origin;
      const link = (label, url, help) => `<div class="linkrow"><div class="grow"><strong>${label}</strong><div class="muted small">${help}</div></div>
        <button class="btn sm" type="button" data-copy="${url}">Copy</button>
        <a class="btn sm" target="_blank" rel="noopener" href="${Ros.waLink('', `${label} for ${e.name}: ${url}`)}">WhatsApp</a></div>`;
      document.getElementById('share-links').innerHTML = [
        link('Couple’s page', `${o}/c/${e.couple_token}`, 'Budget, payments, RSVPs and the day, for the couple. View only.'),
        link('RSVP and aso-ebi page', `${o}/e/${e.public_token}`, 'For family WhatsApp groups. Guests RSVP and order aso-ebi.'),
        link('Usher gate scanner', `${o}/gate/${e.gate_token}`, 'For ushers’ phones. Scans guest QR codes at the gate.'),
        link('Planner (you)', `${o}/p/${token}`, 'Full control. Keep this one private.'),
      ].join('');
      document.getElementById('set-rsvp').checked = Boolean(e.rsvp_open);
      document.getElementById('set-pay').value = e.pay_details || '';
      dlg.showModal();
    });
    dlg.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-copy]');
      if (b) Ros.copy(b.dataset.copy);
    });
    dlg.addEventListener('close', async () => {
      if (dlg.returnValue !== 'save') return;
      await Ros.api('PATCH', `/api/p/${token}/settings`, { rsvp_open: document.getElementById('set-rsvp').checked, pay_details: document.getElementById('set-pay').value });
      Ros.toast('Settings saved');
    });
  }

  return { token, mount };
})();
