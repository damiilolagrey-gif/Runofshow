// Shared by the browser and the server. Times are minutes after midnight on the event date.
(function (root) {
  function fmtTime(min) {
    const m = ((min % 1440) + 1440) % 1440;
    const h24 = Math.floor(m / 60);
    const mm = String(m % 60).padStart(2, '0');
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${h12}:${mm}${h24 < 12 ? 'am' : 'pm'}`;
  }

  function parseTime(str) {
    const m = String(str).trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (!m) return null;
    let h = Number(m[1]);
    const min = Number(m[2] || 0);
    if (min > 59 || h > 23) return null;
    if (m[3]) {
      if (h < 1 || h > 12) return null;
      h = (h % 12) + (m[3] === 'pm' ? 12 : 0);
    }
    return h * 60 + min;
  }

  function fmtShift(minutes) {
    const abs = Math.abs(minutes);
    const text = abs >= 60 && abs % 60 === 0 ? `${abs / 60} hr` : abs > 60 ? `${Math.floor(abs / 60)} hr ${abs % 60} min` : `${abs} min`;
    return `${text} ${minutes > 0 ? 'later' : 'earlier'}`;
  }

  const api = { fmtTime, parseTime, fmtShift };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RosTime = api;
})(this);
