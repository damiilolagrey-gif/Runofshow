/* global Ros */
// The page behind the party QR code: guests send photos and short videos straight from the phone's browser.
(() => {
  const token = location.pathname.split('/').pop();
  const api = `/api/m/${token}`;
  const $ = (id) => document.getElementById(id);
  const nameKey = `ros:m:name:${token}`;
  let limits = { photo_mb: 12, video_mb: 60 };
  let sent = 0;
  try { $('name').value = localStorage.getItem(nameKey) || ''; } catch { /* storage blocked */ }
  $('name').addEventListener('change', () => { try { localStorage.setItem(nameKey, $('name').value.trim()); } catch { /* storage blocked */ } });

  Ros.api('GET', api).then((d) => {
    const e = d.event;
    document.title = `Share your moments · ${e.name}`;
    $('ev-name').textContent = d.couple_names || e.name;
    $('ev-when').textContent = [d.couple_names ? e.name : '', Ros.fmtDate(e.date), e.venue].filter(Boolean).join(' · ');
    limits = d.limits;
    $('limits').textContent = `Videos up to about 30 seconds (${limits.video_mb} MB). Photos up to ${limits.photo_mb} MB.`;
    $('form').classList.toggle('hidden', !d.open);
    $('closed').classList.toggle('hidden', d.open);
  }).catch((err) => { $('ev-name').textContent = err.status === 404 ? 'This link is not valid' : 'Could not load. Check your connection.'; });

  // XHR rather than fetch so guests see upload progress on slow networks.
  function upload(file, li) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${api}/upload`);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('X-Guest-Name', encodeURIComponent($('name').value.trim()));
      const bar = li.querySelector('.bar span');
      const status = li.querySelector('.status');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.style.width = `${Math.round((e.loaded / e.total) * 100)}%`; };
      xhr.onload = () => {
        const ok = xhr.status === 201;
        let msg = 'Sent ✓';
        if (!ok) { try { msg = JSON.parse(xhr.responseText).error; } catch { msg = 'Didn’t send. Try again.'; } }
        status.textContent = msg;
        status.classList.toggle('neg', !ok);
        li.classList.toggle('done', ok);
        if (ok) bar.style.width = '100%';
        if (ok) sent += 1;
        resolve(ok);
      };
      xhr.onerror = () => { status.textContent = 'No connection. Try again when you have signal.'; status.classList.add('neg'); resolve(false); };
      xhr.send(file);
    });
  }

  async function send(files) {
    if (!files.length) return;
    try { localStorage.setItem(nameKey, $('name').value.trim()); } catch { /* storage blocked */ }
    $('sent-card').classList.remove('hidden');
    for (const file of files) {
      const isVideo = file.type.startsWith('video/');
      const li = document.createElement('li');
      const url = URL.createObjectURL(file);
      li.innerHTML = `${isVideo ? `<video src="${url}" muted playsinline preload="metadata"></video>` : `<img src="${url}" alt="">`}
        <div class="grow"><div class="bar"><span></span></div><div class="status small muted">Sending…</div></div>`;
      $('sent').prepend(li);
      const tooBig = file.size > (isVideo ? limits.video_mb : limits.photo_mb) * 1048576;
      if (tooBig) {
        li.querySelector('.status').textContent = isVideo ? 'That video is too long. Try a clip under 30 seconds.' : 'That photo is too big.';
        li.querySelector('.status').classList.add('neg');
        continue;
      }
      await upload(file, li);
      $('sent-title').textContent = `Sent ${sent} · thank you!`;
    }
  }
  for (const id of ['cam-photo', 'cam-video', 'pick']) {
    $(id).addEventListener('change', (e) => { send([...e.target.files]); e.target.value = ''; });
  }
})();
