/* global Ros, RosSection */
(() => {
  const $ = (id) => document.getElementById(id);
  const draftKey = `ros:recap:${RosSection.mode}:${RosSection.token}`;
  let data = null;
  let draft = Ros.cache.get(draftKey);
  const saveDraft = () => Ros.cache.set(draftKey, draft);
  const first = (name) => name.split(/\s+/)[0];

  function render() {
    const s = data.stats;
    $('s-came').textContent = s.people_came || s.people_yes;
    $('s-came-l').textContent = s.people_came ? 'Guests came' : 'Guests said yes';
    $('s-cues').textContent = `${s.cues_done}/${s.cues}`;
    $('s-vendors').textContent = `${s.vendors_in}/${s.vendors}`;
    $('s-rating').textContent = s.average ? `${s.average}★` : '–';
    $('s-rating-l').textContent = s.reviews ? `From ${s.reviews} vendor review${s.reviews === 1 ? '' : 's'}` : 'No vendor reviews yet';
    $('closed').classList.toggle('hidden', data.open);
    $('writer').classList.toggle('hidden', !data.open);
    $('draft').textContent = draft ? 'Write them again' : data.ai ? '✨ Write thank-yous' : 'Write thank-yous';
    $('writer-hint').textContent = draft ? 'Edit anything before you send it.'
      : `${data.ai ? 'Claude writes' : 'Get'} a message for your guests, each vendor${data.who === 'planner' ? ' and the couple' : ''}, using what happened on the day and the couple’s reviews.`;
    $('drafts').classList.toggle('hidden', !draft);
    if (!draft) return;

    // guests
    const waiting = data.guests.filter((g) => !g.thanked_at);
    const withPhone = waiting.filter((g) => g.phone);
    $('g-basis').textContent = `${data.guests.length} ${data.basis === 'arrived' ? 'scanned in at the gate' : 'who said yes (nobody was scanned in)'}`;
    if (document.activeElement !== $('g-text')) $('g-text').value = draft.guests;
    $('g-send-row').classList.toggle('hidden', !data.whatsapp);
    $('g-send').textContent = `Send to ${withPhone.length} guest${withPhone.length === 1 ? '' : 's'} on WhatsApp`;
    $('g-send').disabled = !withPhone.length;
    $('g-sent').textContent = data.guests.length - waiting.length ? `${data.guests.length - waiting.length} already thanked` : '';
    $('g-list').classList.toggle('hidden', data.whatsapp);
    if (!data.whatsapp) {
      $('g-list').innerHTML = data.guests.map((g) => `<li data-id="${g.id}"><span class="grow"><strong>${Ros.esc(g.name)}</strong>${g.thanked_at ? ' <span class="pill ok">Thanked</span>' : ''}</span>
        ${g.phone ? `<a class="btn sm${g.thanked_at ? ' ghost' : ''}" data-act="thank" target="_blank" rel="noopener" href="${Ros.waLink(g.phone, draft.guests.split('{name}').join(first(g.name)))}">Send on WhatsApp</a>` : '<span class="muted small">No number</span>'}</li>`).join('')
        || '<li class="muted">Nobody to thank yet.</li>';
    }

    // couple
    $('couple-box').classList.toggle('hidden', data.who !== 'planner');
    if (document.activeElement !== $('c-text')) $('c-text').value = draft.couple || '';
    $('c-wa').href = Ros.waLink('', draft.couple || '');

    // vendors
    const texts = Object.fromEntries((draft.vendors || []).map((v) => [v.id, v.text]));
    // Leave the list alone while a vendor's message is being edited.
    if (document.activeElement?.dataset?.vendor) return;
    $('v-list').innerHTML = data.vendors.map((v) => `<div class="card card-pad" data-vid="${v.id}">
        <div class="who"><strong>${Ros.esc(v.name)}</strong><span class="muted small">${Ros.esc(v.role)}${v.review ? ` · <span class="rated">${'★'.repeat(v.review.rating)}</span>` : ''}</span></div>
        <textarea data-vendor="${v.id}" maxlength="900" style="margin-top:8px">${Ros.esc(texts[v.id] || '')}</textarea>
        <div class="row" style="margin-top:8px">
          <a class="btn sm" target="_blank" rel="noopener" data-wa="${v.id}" href="${Ros.waLink(v.phone, texts[v.id] || '')}">Send on WhatsApp</a>
          <span class="muted small">${v.phone ? `+${Ros.esc(v.phone)}` : 'No number: WhatsApp will ask who to send it to'}</span>
        </div>
      </div>`).join('') || '<p class="muted">No vendors on this event.</p>';
  }

  async function load() {
    data = await RosSection.api('GET', '/recap');
    render();
  }
  RosSection.start({ section: 'recap', topics: ['recap', 'guests', 'reviews', 'settings'], load });

  $('draft').addEventListener('click', async () => {
    if (draft && !confirm('Write new messages? Your edits will be replaced.')) return;
    const b = $('draft');
    b.disabled = true;
    b.textContent = 'Writing…';
    try {
      draft = await RosSection.api('POST', '/recap/draft');
      saveDraft();
      Ros.toast(draft.source === 'ai' ? 'Written. Read them over before you send.' : 'Drafted. Edit them to add your own touch.');
    } finally {
      b.disabled = false;
      render();
    }
  });

  document.addEventListener('input', (e) => {
    if (!draft) return;
    const t = e.target;
    if (t.id === 'g-text') draft.guests = t.value;
    else if (t.id === 'c-text') { draft.couple = t.value; $('c-wa').href = Ros.waLink('', t.value); }
    else if (t.dataset.vendor) {
      const id = Number(t.dataset.vendor);
      const v = draft.vendors.find((x) => x.id === id);
      if (v) v.text = t.value; else draft.vendors.push({ id, text: t.value });
      const phone = data.vendors.find((x) => x.id === id)?.phone;
      document.querySelector(`[data-wa="${id}"]`).href = Ros.waLink(phone, t.value);
    } else return;
    saveDraft();
  });
  document.addEventListener('change', (e) => { if (e.target.id === 'g-text') render(); });

  $('g-send').addEventListener('click', async () => {
    const n = data.guests.filter((g) => !g.thanked_at && g.phone).length;
    if (!confirm(`Send this thank-you to ${n} guests on WhatsApp?`)) return;
    const r = await RosSection.api('POST', '/recap/thanks/send', { text: draft.guests });
    Ros.toast(r.failed ? `Sent to ${r.sent}. ${r.failed} didn’t go through.` : `Sent to ${r.sent} guests.`);
    load();
  });
  $('g-list').addEventListener('click', (e) => {
    const a = e.target.closest('[data-act=thank]');
    if (a) RosSection.api('POST', `/recap/thanks/${a.closest('[data-id]').dataset.id}/sent`).then(load);
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (b && $(b.dataset.copy)) Ros.copy($(b.dataset.copy).value, 'Message');
  });
})();
