/* global Ros */
// Header for the public pages: shows "My events" when signed in, otherwise log in / start free.
const RosSite = (() => {
  async function me() {
    try { return await Ros.api('GET', '/api/account/me'); } catch { return null; }
  }
  async function header() {
    const nav = document.getElementById('site-nav');
    const who = await me();
    nav.innerHTML = `<a class="btn ghost sm" href="/pricing">Pricing</a>${who
      ? '<a class="btn primary sm" href="/dashboard">My events</a>'
      : '<a class="btn ghost sm" href="/login">Log in</a><a class="btn primary sm" href="/signup">Start free</a>'}`;
    return who;
  }

  // Plan cards shared by the pricing page and the dashboard. onPick(planId, interval) runs for paid plans.
  function plans(el, pricing, { interval = 'monthly', current = null, onPick } = {}) {
    const per = interval === 'annually' ? '/year' : '/month';
    const perks = {
      starter: [`${pricing.plans[0].events} upcoming event`, `Up to ${pricing.plans[0].guests} guests per event`, 'Live timeline, vendor links and alerts', 'Guest QR check-in, aso-ebi, budget'],
      pro: [`Up to ${pricing.plans[1].events} upcoming events`, 'Unlimited guests', 'Everything in Starter', 'Best for working planners'],
      business: ['Unlimited events', 'Unlimited guests', 'Everything in Pro', 'For busy firms and venues'],
    };
    el.innerHTML = pricing.plans.map((p) => {
      const amount = p[interval];
      const isCurrent = current === p.id;
      const btn = isCurrent ? '<button class="btn big" disabled>Your plan</button>'
        : p.id === 'starter' ? (current ? '' : '<a class="btn big" href="/signup">Start free</a>')
          : `<button class="btn primary big" data-plan="${p.id}" ${pricing.enabled ? '' : 'disabled title="Payments are not set up yet"'}>Choose ${p.label}</button>`;
      return `<div class="card plan${isCurrent ? ' current' : ''}${p.id === 'pro' ? ' popular' : ''}">
        <div class="row"><h3 class="grow" style="font-size:1.15rem">${p.label}</h3>${p.id === 'pro' ? '<span class="pill soon plain">Most popular</span>' : ''}</div>
        <div class="price">${amount ? Ros.naira(amount) : '₦0'} <small>${amount ? per : 'forever'}</small></div>
        ${interval === 'annually' && amount ? `<div class="small pos">Save ${Ros.naira(p.monthly * 12 - p.annually)} a year</div>` : ''}
        <ul>${perks[p.id].map((x) => `<li>${x}</li>`).join('')}</ul>
        <div class="grow-space"></div>${btn}
      </div>`;
    }).join('');
    el.onclick = (e) => {
      const b = e.target.closest('[data-plan]');
      if (b && onPick) onPick(b.dataset.plan, interval);
    };
  }

  return { me, header, plans };
})();
