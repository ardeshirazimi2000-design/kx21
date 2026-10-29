// Darman Plus icon set: simple line icons (24×24, drawn with currentColor) for the navigation
// bar and the service tiles. Our own drawings, in the brand's style; no external icon font.
const P = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M8 14h2M14 14h2M8 17.5h2"/>',
  assistant: '<path d="M4 4.5h16a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5h-7l-5 4v-4H4A1.5 1.5 0 0 1 2.5 16V6A1.5 1.5 0 0 1 4 4.5z"/><path d="M12 7.5l1.1 2.4 2.4 1.1-2.4 1.1L12 14.5l-1.1-2.4L8.5 11l2.4-1.1z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  stethoscope: '<path d="M5 3v6a4.5 4.5 0 0 0 9 0V3"/><path d="M9.5 13.5v1.5a5 5 0 0 0 10 0v-2.5"/><circle cx="19.5" cy="10.5" r="2"/>',
  pulse: '<path d="M2.5 12h4l2.2-5.5 4.3 11 2.3-5.5h6.2"/>',
  rx: '<path d="M6 3h8.5L19 7.5V21H6z"/><path d="M14 3v5h5"/><path d="M9 12h3a1.75 1.75 0 0 1 0 3.5H9V11.5M11.5 15.5 14 18.5M14 15.5l-2.5 3"/>',
  pill: '<path d="M10.6 3.6a5 5 0 0 1 7.07 7.07l-7.07 7.07a5 5 0 0 1-7.07-7.07z"/><path d="M7.05 7.05l7.07 7.07"/>',
  doctors: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M15.5 4.6a3.5 3.5 0 0 1 0 6.8M18 13.6a6.5 6.5 0 0 1 3.5 6.4"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 21a2 2 0 0 0 4 0"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="2.5"/><path d="M3 10h18M16 15h2"/><path d="M6 6l9-3 1.5 3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  chart: '<path d="M3 21h18"/><rect x="5" y="11" width="3" height="7" rx="1"/><rect x="10.5" y="5" width="3" height="13" rx="1"/><rect x="16" y="14" width="3" height="4" rx="1"/>',
  approve: '<rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M8 8h8M8 12h4"/><path d="M11 16.5l2 2 4-4.5"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6 15h4"/>',
  book: '<path d="M3 5.5C5.5 4 8.5 4 12 6c3.5-2 6.5-2 9-.5V19c-2.5-1.5-5.5-1.5-9 .5-3.5-2-6.5-2-9-.5z"/><path d="M12 6v13.5"/>',
  catalog: '<path d="M4 4.5h11a3 3 0 0 1 3 3V21H7a3 3 0 0 1-3-3z"/><path d="M4 18a3 3 0 0 1 3-3h11"/><path d="M9 8.5h5M11.5 6v5"/>',
  alert: '<path d="M12 3.5 21.5 20h-19z"/><path d="M12 10v4.5M12 17.3v.2"/>',
  team: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 10-5.5"/><circle cx="17.5" cy="16.5" r="2.2"/><path d="M17.5 12.3v1.5M17.5 19.2v1.5M13.3 16.5h1.5M20.2 16.5h1.5"/>',
  idcard: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="11" r="2"/><path d="M5.8 16a3.4 3.4 0 0 1 6.4 0M14 10h4M14 13.5h4"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3 4v4h4"/><path d="M12 8v4.5l3 1.5"/>',
  logout: '<path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14"/><path d="M9 8l-4 4 4 4M5 12h10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
  support: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="2.5" y="13" width="4" height="6.5" rx="1.5"/><rect x="17.5" y="13" width="4" height="6.5" rx="1.5"/><path d="M19.5 19.5c0 1.6-2 2.5-5 2.5h-2"/>',
};

const tpl = document.createElement('template');

/** An <svg> element for the named icon. */
export function icon(name, size = 24, strokeWidth = 1.8) {
  tpl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[name] ?? P.plus}</svg>`;
  return tpl.content.firstChild;
}

// Small illustrations (patient / doctor) in the brand colours, for the start screen and for
// doctors without a photo. Colours come from CSS variables so they also work in dark mode.
const ILLUS = {
  patient: `
    <circle cx="32" cy="21" r="11" style="fill:var(--ill-main)"/>
    <path d="M10 57c0-12.2 9.8-21 22-21s22 8.8 22 21z" style="fill:var(--ill-main)"/>
    <path d="M24 36.8c2.4 2.2 5 3.2 8 3.2s5.6-1 8-3.2" fill="none" style="stroke:var(--ill-soft)" stroke-width="2.2" stroke-linecap="round"/>
    <circle cx="48.5" cy="45.5" r="11" style="fill:var(--ill-green);stroke:var(--ill-bg)" stroke-width="3"/>
    <path d="M48.5 51.5l-5.2-5.1a3.3 3.3 0 0 1 5.2-4.1 3.3 3.3 0 0 1 5.2 4.1z" fill="#fff"/>`,
  doctor: `
    <circle cx="32" cy="20" r="11" style="fill:var(--ill-dark)"/>
    <path d="M9 58c0-12.6 10.2-22 23-22s23 9.4 23 22z" style="fill:var(--ill-coat);stroke:var(--ill-dark)" stroke-width="2" stroke-linejoin="round"/>
    <path d="M26 36.6L32 47l6-10.4c-1.9-.4-3.9-.6-6-.6s-4.1.2-6 .6z" style="fill:var(--ill-main)"/>
    <path d="M32 47L24 37.5M32 47l8-9.5M32 47v11" fill="none" style="stroke:var(--ill-dark)" stroke-width="2" stroke-linecap="round"/>
    <path d="M23.5 38.5c-2.6 3.4-3.4 7.4-2.6 11.5" fill="none" style="stroke:var(--ill-dark)" stroke-width="2.2" stroke-linecap="round"/>
    <circle cx="21.2" cy="52.3" r="3.2" style="fill:var(--ill-green);stroke:var(--ill-dark)" stroke-width="1.6"/>
    <path d="M40.5 38.5c2 2.6 2.6 5.4 2.2 8.4" fill="none" style="stroke:var(--ill-dark)" stroke-width="2.2" stroke-linecap="round"/>
    <rect x="41.5" y="49" width="8" height="8" rx="2" style="fill:var(--ill-green)"/>
    <path d="M45.5 50.8v4.4M43.3 53h4.4" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>`,
};

/** An illustration (<svg>) — 'patient' or 'doctor'. */
export function illus(name, size = 44) {
  tpl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true" focusable="false"><g transform="translate(0 6)">${ILLUS[name]}</g></svg>`;
  return tpl.content.firstChild;
}
