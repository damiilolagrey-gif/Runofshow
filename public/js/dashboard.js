/* global Ros, RosSite */
(() => {
  const $ = (id) => document.getElementById(id);
  let me = null;
  let interval = 'monthly';

  const billing = new URLSearchParams(location.search).get('billing');
  if (billing) {
    $('banner').textContent = billing === 'ok' ? 'Payment received. Thank you!' : "That payment didn't go through. You haven't been charged.";
    $('banner').classList.remove('hidden');
    history.replaceState(null, '', '/dashboard');
  }

  async function load() {
    try { me = await Ros.api('GET', '/api/account/me'); } catch { location.href = '/login?next=/dashboard'; return; }
    render();
  }

  function render() {
    const p = me.pricing;
    $('who').textContent = me.planner.name;
    $('plan-name').textContent = me.plan_label;
    const limit = me.limits.events === null ? 'Unlimited events' : `${me.active_events} of ${me.limits.events} upcoming event${me.limits.events === 1 ? '' : 's'} used`;
    const guests = me.limits.guests === null ? 'unlimited guests' : `up to ${me.limits.guests} guests each`;
    const until = me.plan_until ? ` · ${me.renewing ? 'Renews' : 'Paid until'} ${Ros.fmtDate(me.plan_until)}` : '';
    $('plan-detail').textContent = me.enforced ? `${limit}, ${guests}${until}` : 'All features unlocked while payments are being set up.';
    $('change-plan').textContent = me.plan === 'starter' ? 'Upgrade' : 'Change plan';
    $('change-plan').classList.toggle('hidden', !p.enabled);
    $('cancel').classList.toggle('hidden', !me.renewing);
    RosSite.plans($('plans'), p, { interval, current: me.plan, onPick: subscribe });

    const today = new Date().toISOString().slice(0, 10);
    $('events').innerHTML = me.events.map((e) => {
      const past = e.date < today;
      const unlock = p.enabled && !e.unlocked && !past && me.plan === 'starter'
        ? `<button class="btn sm" data-unlock="${e.id}" title="Unlimited guests, and it won't count against your plan">Unlock · ${Ros.naira(p.event_price)}</button>` : '';
      return `<li><div><a class="ev" href="${e.planner_url}">${Ros.esc(e.name)}</a>
          <div class="muted small">${Ros.fmtDate(e.date)}${e.venue ? ` · ${Ros.esc(e.venue)}` : ''} · ${e.guests} guest${e.guests === 1 ? '' : 's'}</div></div>
        <div class="row">${e.unlocked ? '<span class="pill ok">Unlocked</span>' : past ? '<span class="pill">Past</span>' : ''}${unlock}<a class="btn sm primary" href="${e.planner_url}">Open</a></div></li>`;
    }).join('') || '<li class="muted">No events yet. Create your first one.</li>';

    $('payout-card').classList.toggle('hidden', !p.enabled);
    $('payout-help').textContent = `Add the bank account where aso-ebi card payments should land. Paystack pays you directly; we keep ${p.asoebi_fee_percent}% per sale. Until you add one, buyers can only pay by bank transfer.`;
    $('payout').querySelector('button').textContent = me.payout ? 'Change payout account' : 'Save payout account';
    $('payout-current').innerHTML = me.payout ? `<span class="pill ok">Paying out to ${Ros.esc(me.payout.name)} · ${Ros.esc(me.payout.bank)} ${Ros.esc(me.payout.account)}</span>` : '';
  }

  async function subscribe(plan, iv) {
    try { location.href = (await Ros.api('POST', '/api/account/subscribe', { plan, interval: iv })).pay_url; }
    catch (err) { Ros.toast(err.message); }
  }

  $('change-plan').onclick = () => $('plan-picker').classList.toggle('hidden');
  $('interval').onclick = (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    interval = b.dataset.i;
    document.querySelectorAll('#interval [data-i]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  };
  $('cancel').onclick = async () => {
    if (!confirm(`Stop renewing? You keep ${me.plan_label} until ${Ros.fmtDate(me.plan_until)}.`)) return;
    try { await Ros.api('POST', '/api/account/cancel'); Ros.toast('Renewal stopped'); load(); } catch (err) { Ros.toast(err.message); }
  };
  $('logout').onclick = async () => { await Ros.api('POST', '/api/account/logout'); location.href = '/'; };
  $('events').onclick = async (e) => {
    const b = e.target.closest('[data-unlock]');
    if (!b) return;
    try { location.href = (await Ros.api('POST', '/api/account/unlock-event', { event_id: Number(b.dataset.unlock) })).pay_url; } catch (err) { Ros.toast(err.message); }
  };

  const form = $('create');
  form.date.value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  Ros.api('GET', '/api/templates').then((list) => {
    form.type.innerHTML = list.map((t) => `<option value="${t.id}">${Ros.esc(t.label)}${t.cues ? ` (${t.cues} cues, ${t.vendors} vendors)` : ''}</option>`).join('');
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { planner_url } = await Ros.api('POST', '/api/events', Object.fromEntries(new FormData(form)));
      location.href = planner_url;
    } catch (err) {
      Ros.toast(err.message);
      if (err.status === 402) $('plan-picker').classList.remove('hidden');
    }
  });

  // ---------- planning assistant ----------

  let draft = null;
  const draftInput = () => ({ ...Object.fromEntries(new FormData(form)) });
  Ros.api('GET', '/api/events/draft').then(({ ai }) => {
    if (!ai) $('brief-help').textContent = 'Drafts from the template for now, with a budget split if you give a total. Full AI drafting switches on once the Claude API key is added.';
  }).catch(() => {});

  async function makeDraft() {
    if (!form.reportValidity()) return;
    if (!form.brief.value.trim()) { Ros.toast('Describe the event first, or create it from the template'); form.brief.focus(); return; }
    for (const b of [$('draft'), $('draft-again')]) { b.disabled = true; }
    $('draft').textContent = '✨ Drafting… this can take a minute';
    try {
      draft = await Ros.api('POST', '/api/events/draft', draftInput());
      renderDraft();
      $('draft-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) { Ros.toast(err.message); }
    finally {
      for (const b of [$('draft'), $('draft-again')]) { b.disabled = false; }
      $('draft').textContent = '✨ Draft the plan';
    }
  }

  function renderDraft() {
    const d = draft;
    const f = draftInput();
    $('draft-card').classList.remove('hidden');
    $('draft-source').textContent = d.source === 'ai' ? 'Drafted by AI' : 'From template';
    $('draft-head').innerHTML = `<div style="font-size:1.2rem;font-weight:800">${Ros.esc(f.name)}</div>
      <div class="muted small">${Ros.fmtDate(f.date)}${f.venue ? ` · ${Ros.esc(f.venue)}` : ''}</div>${d.summary ? `<p style="margin:8px 0 0">${Ros.esc(d.summary)}</p>` : ''}`;
    const total = d.budget.reduce((s, l) => s + l.naira, 0);
    $('draft-stats').innerHTML = [[d.cues.length, 'Cues on the day'], [d.vendors.length, 'Vendors to book'], [d.checklist.length, 'Checklist items'], [total ? Ros.naira(total * 100) : '–', d.guest_count ? `Budget · ${d.guest_count} guests` : 'Budget']]
      .map(([n, l]) => `<div class="card stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
    $('draft-cues').innerHTML = d.cues.map((c) => `<li class="cue" style="grid-template-columns:70px minmax(0,1fr)"><div class="time">${Ros.fmt(c.start_min)}<span class="dur">${c.duration} min</span></div>
      <div class="what"><div class="t">${Ros.esc(c.title)}</div><div class="chips">${c.roles.map((r) => `<span class="chip">${Ros.esc(r)}</span>`).join('')}</div></div></li>`).join('');
    $('draft-vendors').innerHTML = d.vendors.map((v) => `<span class="chip">${Ros.esc(v.role)}${v.name !== v.role ? ` · ${Ros.esc(v.name)}` : ''}</span>`).join('');
    $('draft-budget').innerHTML = d.budget.map((l) => `<tr><td>${Ros.esc(l.category)}</td><td class="num">${Ros.naira(l.naira * 100)}</td></tr>`).join('')
      || '<tr><td class="muted">Give a total budget in the description to get a split.</td></tr>';
    const cats = new Map();
    for (const c of d.checklist) cats.set(c.category, (cats.get(c.category) || 0) + 1);
    $('draft-checklist').innerHTML = [...cats].map(([c, n]) => `<li><span class="grow">${Ros.esc(c)}</span><span class="count">${n} item${n === 1 ? '' : 's'}</span></li>`).join('');
    $('draft-info').innerHTML = d.guest_info ? `<h3 class="small muted" style="text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">For guests</h3><div class="small" style="white-space:pre-wrap">${Ros.esc(d.guest_info)}</div>` : '';
  }

  $('draft').addEventListener('click', makeDraft);
  $('draft-again').addEventListener('click', makeDraft);
  $('draft-discard').addEventListener('click', () => { draft = null; $('draft-card').classList.add('hidden'); });
  $('draft-create').addEventListener('click', async () => {
    $('draft-create').disabled = true;
    try {
      const { planner_url } = await Ros.api('POST', '/api/events', { ...draftInput(), plan: draft });
      location.href = planner_url;
    } catch (err) {
      Ros.toast(err.message);
      if (err.status === 402) $('plan-picker').classList.remove('hidden');
      $('draft-create').disabled = false;
    }
  });

  $('claim').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await Ros.api('POST', '/api/account/claim', { link: e.target.link.value }); Ros.toast(`Added ${r.name}`); e.target.reset(); load(); }
    catch (err) { Ros.toast(err.message); }
  });

  let banksLoaded = false;
  async function loadBanks() {
    if (banksLoaded || !me?.pricing.enabled) return;
    banksLoaded = true;
    try {
      const banks = await Ros.api('GET', '/api/account/banks');
      $('bank').innerHTML = '<option value="">Choose your bank</option>' + banks.map((b) => `<option value="${Ros.esc(b.code)}">${Ros.esc(b.name)}</option>`).join('');
    } catch { $('bank').innerHTML = '<option value="">Could not load banks</option>'; banksLoaded = false; }
  }
  $('payout').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await Ros.api('POST', '/api/account/payout', Object.fromEntries(new FormData(e.target))); Ros.toast(`Saved: ${r.name}`); e.target.reset(); load(); }
    catch (err) { Ros.toast(err.message); }
  });

  load().then(loadBanks);
  Ros.registerSW();
})();
