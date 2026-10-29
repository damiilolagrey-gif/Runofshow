/* global Ros, RosSection */
// WhatsApp-style inbox for the couple and the planner: guest chats on the left, the conversation on the right.
(() => {
  const $ = (id) => document.getElementById(id);
  const rsvpPill = { yes: '<span class="pill ok">Coming</span>', no: '<span class="pill late">Can’t come</span>', pending: '<span class="pill">Not replied</span>' };
  let inbox = { conversations: [], whatsapp: false };
  let guests = [];
  let current = null; // { guest, messages, window_open }

  const when = (iso) => {
    const d = new Date(iso);
    return d.toDateString() === new Date().toDateString() ? Ros.timeAgo(iso) : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  };
  const initials = (name) => name.split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();

  function renderList() {
    const q = $('q').value.trim().toLowerCase();
    const match = (g) => !q || g.name.toLowerCase().includes(q) || (g.phone || '').includes(q.replace(/\D/g, '') || '~');
    const chats = inbox.conversations.filter(match);
    const withChat = new Set(inbox.conversations.map((c) => c.id));
    const others = q ? guests.filter((g) => !withChat.has(g.id) && g.phone && match(g)).slice(0, 20) : [];
    const row = (g, preview, time, unread) => `<li><button type="button" data-id="${g.id}" class="${current?.guest.id === g.id ? 'on' : ''}">
        <span class="avatar">${Ros.esc(initials(g.name))}</span>
        <span class="grow"><span class="top"><strong>${Ros.esc(g.name)}</strong><time>${time}</time></span>
          <span class="bottom"><span class="preview">${preview}</span>${unread ? `<span class="badge">${unread}</span>` : ''}</span></span>
      </button></li>`;
    $('convos').innerHTML = chats.map((c) => row(c, `${c.last_direction === 'out' ? '<span class="muted">You: </span>' : ''}${Ros.esc(c.last_body)}`, when(c.last_at), c.unread)).join('')
      + (others.length ? `<li class="inbox-sep">Start a chat</li>${others.map((g) => row(g, '<span class="muted">No messages yet</span>', '', 0)).join('')}` : '')
      || `<li class="inbox-sep">${q ? 'No guest matches that.' : 'No chats yet. Guests’ WhatsApp replies to invites show up here.'}</li>`;
  }

  function renderChat() {
    $('pick').classList.toggle('hidden', Boolean(current));
    $('open').classList.toggle('hidden', !current);
    $('inbox').classList.toggle('chatting', Boolean(current));
    if (!current) return;
    const { guest: g, messages } = current;
    $('c-name').textContent = g.name;
    $('c-sub').innerHTML = [rsvpPill[g.rsvp], g.rsvp === 'yes' ? `${g.party_size} ${g.party_size === 1 ? 'person' : 'people'}` : '', g.table_label ? `Table ${Ros.esc(g.table_label)}` : '', g.phone ? `+${Ros.esc(g.phone)}` : 'No number']
      .filter(Boolean).join(' · ');
    $('c-bot').checked = !g.bot_paused;
    $('c-bot').disabled = !inbox.whatsapp;
    const who = (m) => (m.direction === 'in' ? '' : m.sender === 'host' ? 'You' : 'Assistant');
    $('c-msgs').innerHTML = messages.map((m) => `<li class="${m.direction}">${Ros.esc(m.body)}<time>${who(m) ? `${who(m)} · ` : ''}${when(m.at)}</time></li>`).join('')
      || '<li class="in muted">No messages yet. Say hello.</li>';
    $('c-msgs').scrollTop = $('c-msgs').scrollHeight;
    $('c-send').disabled = !g.phone;
    $('c-note').textContent = !g.phone ? 'Add this guest’s WhatsApp number on the Guests tab to message them.'
      : !inbox.whatsapp ? 'Send opens WhatsApp on your phone with this message ready.'
      : current.window_open ? (g.bot_paused ? 'You’re handling this chat. The assistant won’t reply.' : 'The assistant replies to this guest for you. Untick “Assistant replies” to take over.')
      : 'This guest hasn’t written in the last 24 hours, so your message goes out as your approved WhatsApp template.';
  }

  async function loadList() {
    [inbox, { guests }] = await Promise.all([RosSection.api('GET', '/inbox'), RosSection.api('GET', '/guests')]);
    $('no-wa').classList.toggle('hidden', inbox.whatsapp);
    renderList();
  }
  async function openChat(id) {
    current = await RosSection.api('GET', `/inbox/${id}`);
    renderChat();
    const c = inbox.conversations.find((x) => x.id === id);
    if (c) c.unread = 0;
    renderList();
  }
  async function load() {
    await loadList();
    if (current) {
      const fresh = await RosSection.api('GET', `/inbox/${current.guest.id}`);
      const changedMsgs = fresh.messages.length !== current.messages.length;
      current = fresh;
      if (changedMsgs || document.activeElement !== $('c-text')) renderChat();
      const c = inbox.conversations.find((x) => x.id === current.guest.id);
      if (c) { c.unread = 0; renderList(); }
    }
  }
  RosSection.start({ section: 'inbox', topics: ['inbox', 'guests'], load });

  $('convos').addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (b) openChat(Number(b.dataset.id));
  });
  $('q').addEventListener('input', renderList);
  $('back').addEventListener('click', () => { current = null; renderChat(); renderList(); });

  $('c-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('c-text').value.trim();
    if (!text || !current) return;
    $('c-send').disabled = true;
    try {
      const r = await RosSection.api('POST', `/inbox/${current.guest.id}`, { text });
      $('c-text').value = '';
      if (r.manual) window.open(r.wa_url, '_blank', 'noopener');
      await load();
    } finally {
      $('c-send').disabled = !current?.guest.phone;
    }
  });
  $('c-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) { e.preventDefault(); $('c-form').requestSubmit(); }
  });
  $('c-bot').addEventListener('change', async () => {
    await RosSection.api('PATCH', `/inbox/${current.guest.id}`, { bot_paused: !$('c-bot').checked });
    current.guest.bot_paused = !$('c-bot').checked;
    renderChat();
  });
})();
