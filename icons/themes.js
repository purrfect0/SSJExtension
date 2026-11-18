// Stable IDs are shared by settings, the popup and exported friend builds.
export const iconThemes = [
  { id: 'mint', name: 'Мята', sub: 'мятная' },
  { id: 'midnight', name: 'Графит', sub: 'графитовая' },
  { id: 'violet', name: 'Лаванда', sub: 'фиолетовая' },
  { id: 'coral', name: 'Коралл', sub: 'коралловая' },
  { id: 'ice', name: 'Лёд', sub: 'ледяная' }
];

export const iconThemeIds = iconThemes.map(({ id }) => id);
