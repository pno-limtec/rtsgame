// Curated Pixabay audio manifest. Source pages are kept beside the CDN URLs so licenses can
// be checked later; playback uses the direct MP3 URL exposed by each Pixabay media page.
// Durchgängig rockiger Soundtrack: 'calm' = treibender Groove-/Industrial-Rock als Hintergrund,
// 'combat' = harter Rock im Gefecht (kein Klavier mehr).
export const MUSIC_PLAYLISTS = {
  calm: [
    {
      title: 'Cool Dude - Energetic Electronic Rock',
      page: 'https://pixabay.com/music/beats-cool-dude-energetic-electronic-rock-390021/',
      src: 'https://cdn.pixabay.com/download/audio/2025/08/15/audio_cd93da8f42.mp3?filename=emmraan-cool-dude-energetic-electronic-rock-390021.mp3',
    },
    {
      title: 'Stylish Rock Beat Trailer Monochrome',
      page: 'https://pixabay.com/music/beats-stylish-rock-beat-trailer-monochrome-116346/',
      src: 'https://cdn.pixabay.com/download/audio/2022/08/03/audio_626ecbb571.mp3?filename=comastudio-stylish-rock-beat-trailer_monochrome-116346.mp3',
    },
    {
      title: 'Cool Stylish Driving Rock',
      page: 'https://pixabay.com/music/hard-rock-cool-stylish-driving-rock-246334/',
      src: 'https://cdn.pixabay.com/download/audio/2024/10/01/audio_7c49950d68.mp3?filename=emmraan-cool-stylish-driving-rock-246334.mp3',
    },
    {
      title: 'Apocalypse',
      page: 'https://pixabay.com/music/upbeat-apocalypse-254123/',
      src: 'https://cdn.pixabay.com/download/audio/2024/10/23/audio_7d2ab41a06.mp3?filename=emmraan-apocalypse-254123.mp3',
    },
    {
      title: 'Wild Car Driving Powerful Industrial Sport Rock',
      page: 'https://pixabay.com/music/rock-wild-car-driving-powerful-industrial-sport-rock-282915/',
      src: 'https://cdn.pixabay.com/download/audio/2025/01/09/audio_24f39ae8f1.mp3?filename=emmraan-wild-car-driving-powerful-industrial-sport-rock-282915.mp3',
    },
  ],
  combat: [
    {
      title: 'Ready To Fight',
      page: 'https://pixabay.com/music/rock-ready-to-fight-282932/',
      src: 'https://cdn.pixabay.com/download/audio/2025/01/09/audio_c93fcacee1.mp3?filename=emmraan-ready-to-fight-282932.mp3',
    },
    {
      title: 'Faster',
      page: 'https://pixabay.com/music/rock-faster-261259/',
      src: 'https://cdn.pixabay.com/download/audio/2024/11/07/audio_d54ae4730c.mp3?filename=emmraan-faster-261259.mp3',
    },
    {
      title: 'Cool Powerful Hard Rock',
      page: 'https://pixabay.com/music/rock-cool-powerful-hard-rock-243776/',
      src: 'https://cdn.pixabay.com/download/audio/2024/09/23/audio_ecd0727f85.mp3?filename=emmraan-cool-powerful-hard-rock-243776.mp3',
    },
    {
      title: 'Cool Strong Hard Rock',
      page: 'https://pixabay.com/music/hard-rock-cool-strong-hard-rock-244705/',
      src: 'https://cdn.pixabay.com/download/audio/2024/09/26/audio_63d2a32346.mp3?filename=emmraan-cool-strong-hard-rock-244705.mp3',
    },
    {
      title: 'Bulldog Heavy Rock',
      page: 'https://pixabay.com/music/rock-bulldog-heavy-rock-237410/',
      src: 'https://cdn.pixabay.com/download/audio/2024/09/02/audio_96c89bca97.mp3?filename=emmraan-bulldog-heavy-rock-237410.mp3',
    },
  ],
};

export const SFX_SAMPLES = {
  explosion: [
    'https://cdn.pixabay.com/download/audio/2025/05/18/audio_a3b384a2d2.mp3?filename=soundreality-explosion-fx-343683.mp3',
    'https://cdn.pixabay.com/download/audio/2024/02/08/audio_b7f03fb030.mp3?filename=daviddumaisaudio-large-underwater-explosion-190270.mp3',
  ],
  shoot: [
    'https://cdn.pixabay.com/download/audio/2022/03/15/audio_86a8da4ff6.mp3?filename=freesound_community-shoot-1-81135.mp3',
    'https://cdn.pixabay.com/download/audio/2022/03/15/audio_828057d068.mp3?filename=freesound_community-shoot-6-81136.mp3',
  ],
  artillery: [
    'https://cdn.pixabay.com/download/audio/2022/01/18/audio_cc173599c2.mp3?filename=freesound_community-artillery-gunfire-14607.mp3',
    'https://cdn.pixabay.com/download/audio/2025/08/13/audio_ef50635516.mp3?filename=dev_guy-ww2-field-artillery-389483.mp3',
  ],
  gunfire: [
    'https://cdn.pixabay.com/download/audio/2025/11/19/audio_3a290902f3.mp3?filename=ya_dmutro-continuous-automatic-gun-battle-sound-effect-439302.mp3',
    'https://cdn.pixabay.com/download/audio/2022/03/17/audio_557f9d83b9.mp3?filename=freesound_community-gunfire-single-shot-colt-peacemaker-94951.mp3',
  ],
  construction: [
    'https://cdn.pixabay.com/download/audio/2022/03/10/audio_f365c249a1.mp3?filename=freesound_community-construction-35446.mp3',
    'https://cdn.pixabay.com/download/audio/2022/03/09/audio_41942b7caf.mp3?filename=freesound_community-construction-drilling-24221.mp3',
  ],
  yes: [
    'https://cdn.pixabay.com/download/audio/2022/03/19/audio_14ce860b16.mp3?filename=freesound_community-yes-96786.mp3',
    'https://cdn.pixabay.com/download/audio/2022/03/15/audio_f353fb5d17.mp3?filename=freesound_community-yes-laugh-82035.mp3',
  ],
};
