export const AVATAR_OPTIONS = [
  {
    id: 'classic',
    name: 'Regwiz Classic',
    url: '/assets/Regwiz.glb',
    swatch: 'linear-gradient(160deg, #eb1700, #7a0f00)',
    voice: 'shimmer',
  },
  {
    id: 'shah_rukh',
    name: 'Shah_Rukh',
    url: '/assets/Shah_Rukh.glb',
    swatch: 'linear-gradient(160deg, #3a6ea5, #173456)',
    voice: 'verse',
  },
  {
    id: 'onyx',
    name: 'Onyx (British Accent)',
    url: '/assets/Onyx.glb',
    swatch: 'linear-gradient(160deg, #4c9a6a, #1f4630)',
    voice: 'fable',
  },
];

export const DEFAULT_AVATAR_ID = AVATAR_OPTIONS[0].id;

export function avatarById(id) {
  return AVATAR_OPTIONS.find((a) => a.id === id) || AVATAR_OPTIONS[0];
}