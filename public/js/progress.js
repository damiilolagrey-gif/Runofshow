/* global Ros, RosSection */
(() => {
  const $ = (id) => document.getElementById(id);
  let data = { items: [], vendors: [], summary: { categories: [] }, note: {} };

  function render() {
    const s = data.summary;
    $('pct').textContent = `${s.percent}%`;
    $('of').textContent = `${s.locked} of ${s.total}\nlocked in`;
    $('ring').setAttribute('aria-label', `${s.percent}% locked in`);
    $('ring-fill').style.strokeDashoffset = String(326.73 * (1 - s.percent / 100));
    $('empty').classList.toggle('hidden', data.items.length > 0);

    const groups = new Map();
    for (const i of data.items) groups.set(i.category, [...(groups.get(i.category) || []), i]);
    $('groups').innerHTML = [...groups].map(([cat, items]) => `
      <h3 class="small muted" style="margin:16px 16px 4px;text-transform:uppercase;letter-spacing:.06em">${Ros.esc(cat)} · ${items.filter((i) => i.locked).length} of ${items.length}</h3>
      <ul class="vlist">${items.map((i) => `<li data-id="${i.id}">
        <label class="inline" style="min-width:0"><input type="checkbox" data-act="lock" ${i.locked ? 'checked' : ''} ${i.auto ? 'disabled title="Ticked because the vendor accepted"' : ''}>
          <span><span style="font-weight:600">${Ros.esc(i.title)}</span>${i.vendor_name ? `<span class="muted small"> · ${i.auto ? `✓ ${Ros.esc(i.vendor_name)} accepted` : `ticks when ${Ros.esc(i.vendor_name)} accepts`}</span>` : ''}</span></label>
        <button class="btn sm ghost" data-act="edit">Edit</button></li>`).join('')}</ul>`).join('');

    $('cat-list').innerHTML = [...groups.keys()].map((c) => `<option value="${Ros.esc(c)}">`).join('');
    $('i-vendor').innerHTML = '<option value="">None</option>' + data.vendors.map((v) => `<option value="${v.id}">${Ros.esc(v.role)} · ${Ros.esc(v.name)}</option>`).join('');
  }

  let noteLoaded = false;
  async function load() {
    data = await RosSection.api('GET', '/progress');
    render();
    // Don't overwrite what the planner is typing when another screen changes the checklist.
    if (!noteLoaded) {
      $('n-names').value = data.note.couple_names;
      $('n-note').value = data.note.couple_note;
      $('n-phone').value = data.note.contact_phone ? `+${data.note.contact_phone}` : '';
      noteLoaded = true;
    }
  }

  RosSection.start({ section: 'progress', topics: ['progress', 'money'], load });
  RosSection.api('GET', '').then(({ event }) => { $('open-couple').href = `/c/${event.couple_token}`; });

  const openItem = RosSection.dialog('item-dlg', {
    fill(form, item) {
      $('item-title').textContent = item ? 'Edit item' : 'Add item';
      form.category.value = item?.category || '';
      form.title.value = item?.title || '';
      form.vendor_id.value = item?.vendor_id || '';
      form.locked.checked = Boolean(item?.locked_at);
    },
    async save(form, item) {
      const body = { category: form.category.value, title: form.title.value, vendor_id: form.vendor_id.value || null, locked: form.locked.checked };
      await RosSection.api(item ? 'PATCH' : 'POST', item ? `/progress/${item.id}` : '/progress', body);
      load();
    },
    async remove(item) { await RosSection.api('DELETE', `/progress/${item.id}`); load(); },
  });

  $('add-item').addEventListener('click', () => openItem(null));
  $('starter').addEventListener('click', async () => {
    const { added } = await RosSection.api('POST', '/progress/starter');
    Ros.toast(added ? `Added ${added} items` : 'This event type has no starter checklist. Add your own items.');
    load();
  });
  $('groups').addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const item = data.items.find((i) => i.id === Number(el.closest('[data-id]').dataset.id));
    if (el.dataset.act === 'edit') openItem(item);
    if (el.dataset.act === 'lock') { await RosSection.api('PATCH', `/progress/${item.id}`, { locked: el.checked }); load(); }
  });
  $('note-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await RosSection.api('PATCH', '/progress/note', { couple_names: $('n-names').value, couple_note: $('n-note').value, contact_phone: $('n-phone').value });
    Ros.toast('Saved. The couple sees it now.');
  });
})();
