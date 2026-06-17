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
    {
      title: 'Explosion Hit',
      page: 'https://pixabay.com/de/sound-effects/film-spezialeffekte-079996-explosion-hitwav-36483/',
      src: 'https://cdn.pixabay.com/download/audio/2022/03/10/audio_7b6711d1e7.mp3?filename=freesound_community-079996_explosion_hitwav-36483.mp3',
    },
    {
      title: 'Grenade Fire Explosion',
      page: 'https://pixabay.com/de/sound-effects/film-spezialeffekte-grenade-fire-eplosion-05-96471/',
      src: 'https://cdn.pixabay.com/download/audio/2022/03/19/audio_36d361ac66.mp3?filename=freesound_community-grenade_fire_eplosion_05-96471.mp3',
    },
    {
      title: 'Explosion',
      page: 'https://pixabay.com/de/sound-effects/film-spezialeffekte-explosion-42132/',
      src: 'https://cdn.pixabay.com/download/audio/2022/03/10/audio_04c9f7ac5b.mp3?filename=freesound_community-explosion-42132.mp3',
    },
    {
      title: 'Medium Explosion',
      page: 'https://pixabay.com/de/sound-effects/film-spezialeffekte-medium-explosion-40472/',
      src: 'https://cdn.pixabay.com/download/audio/2022/03/10/audio_174242f3f4.mp3?filename=freesound_community-medium-explosion-40472.mp3',
    },
  ],
  shoot: [
    {
      title: 'Gun Shots',
      page: 'https://pixabay.com/de/sound-effects/film-spezialeffekte-gun-shots-91526/',
      src: 'https://cdn.pixabay.com/download/audio/2022/03/15/audio_a582da1309.mp3?filename=freesound_community-gun-shots-91526.mp3',
    },
    {
      title: 'Bullet',
      page: 'https://pixabay.com/de/sound-effects/film-spezialeffekte-080879-bullet-39801/',
      src: 'https://cdn.pixabay.com/download/audio/2022/03/10/audio_bfadd29658.mp3?filename=freesound_community-080879_bullet-39801.mp3',
    },
    {
      title: 'Heavy Shot',
      page: 'https://pixabay.com/de/sound-effects/grusel-heavy-shot-sound-477215/',
      src: 'https://cdn.pixabay.com/download/audio/2026/01/31/audio_c18496fad6.mp3?filename=soundtaker-heavy-shot-sound-477215.mp3',
    },
  ],
  artillery: [
    {
      title: 'Cannon Explosion',
      page: 'https://pixabay.com/de/sound-effects/film-spezialeffekte-cannon-explosion-39434/',
      src: 'https://cdn.pixabay.com/download/audio/2022/03/10/audio_046a10d04b.mp3?filename=freesound_community-cannon-explosion-39434.mp3',
    },
    {
      title: 'Heavy Shot',
      page: 'https://pixabay.com/de/sound-effects/grusel-heavy-shot-sound-477215/',
      src: 'https://cdn.pixabay.com/download/audio/2026/01/31/audio_c18496fad6.mp3?filename=soundtaker-heavy-shot-sound-477215.mp3',
    },
  ],
  gunfire: [
    {
      title: 'Light Machine Gun M249',
      page: 'https://pixabay.com/de/sound-effects/film-spezialeffekte-080968-light-machine-gun-m249-39833/',
      src: 'https://cdn.pixabay.com/download/audio/2022/03/10/audio_d23ed94802.mp3?filename=freesound_community-080968_light-machine-gun-m249-39833.mp3',
    },
  ],
  hit: [
    {
      title: 'Impact',
      page: 'https://pixabay.com/de/sound-effects/film-spezialeffekte-081895-impact-wav-43951/',
      src: 'https://cdn.pixabay.com/download/audio/2022/03/10/audio_d89feebeec.mp3?filename=freesound_community-081895_impact_wav-43951.mp3',
    },
    {
      title: 'Bullet Hit',
      page: 'https://pixabay.com/de/sound-effects/film-spezialeffekte-086569-bullet-hit-39852/',
      src: 'https://cdn.pixabay.com/download/audio/2022/03/10/audio_710545e9e0.mp3?filename=freesound_community-086569_bullet-hit-39852.mp3',
    },
  ],
  laser: [
    {
      title: 'Laser',
      page: 'https://pixabay.com/de/sound-effects/film-spezialeffekte-laser-93507/',
      src: 'https://cdn.pixabay.com/download/audio/2022/03/15/audio_459ab58c40.mp3?filename=freesound_community-laser-93507.mp3',
    },
  ],
  missileFire: [
    {
      title: 'Missile Firing',
      page: 'https://pixabay.com/de/sound-effects/film-spezialeffekte-missile-firing-fl-106655/',
      src: 'https://cdn.pixabay.com/download/audio/2022/03/25/audio_2a22397f5f.mp3?filename=freesound_community-missile-firing-fl-106655.mp3',
    },
  ],
  missileBlast: [
    {
      title: 'Missile Blast',
      page: 'https://pixabay.com/de/sound-effects/film-spezialeffekte-missile-blast-2-95177/',
      src: 'https://cdn.pixabay.com/download/audio/2022/03/17/audio_9c0100efb9.mp3?filename=freesound_community-missile-blast-2-95177.mp3',
    },
  ],
  vehicleTrack: [
    {
      title: 'Tank Track Ratteling',
      page: 'https://pixabay.com/de/sound-effects/film-spezialeffekte-tank-track-ratteling-197409/',
      src: 'https://cdn.pixabay.com/download/audio/2024/03/20/audio_b579992089.mp3?filename=u_3rdmeaw7un-tank-track-ratteling-197409.mp3',
    },
  ],
  workVehicleStart: [
    {
      title: 'Diesel Truck Passing',
      page: 'https://pixabay.com/de/sound-effects/stadt-diesel-truck-passing-369306/',
      src: 'https://cdn.pixabay.com/audio/2025/07/03/audio_c6741c423a.mp3',
    },
    {
      title: 'truck-idle',
      page: 'https://pixabay.com/de/sound-effects/technologie-truck-idle-90932/',
      src: 'https://cdn.pixabay.com/audio/2022/03/15/audio_dcce72ba65.mp3',
    },
  ],
  helicopter: [
    {
      title: 'Helicopter',
      page: 'https://pixabay.com/de/sound-effects/stadt-helicopter-461638/',
      src: 'https://cdn.pixabay.com/download/audio/2026/01/05/audio_5c33fab0ac.mp3?filename=eaglaxle-helicopter-461638.mp3',
    },
  ],
  plane: [
    {
      title: 'Plane From Distance',
      page: 'https://pixabay.com/de/sound-effects/film-spezialeffekte-plane-sound-from-distance-hq-247602/',
      src: 'https://cdn.pixabay.com/download/audio/2024/10/05/audio_06efc774ab.mp3?filename=tanweraman-plane-sound-from-distance-hq-247602.mp3',
    },
    {
      title: 'Small Propeller Airplane',
      page: 'https://pixabay.com/de/sound-effects/film-spezialeffekte-small-propeller-airplane-so-359217/',
      src: 'https://cdn.pixabay.com/download/audio/2025/06/12/audio_44d261dd96.mp3?filename=pwlpl-small-propeller-airplane-so-359217.mp3',
    },
  ],
  thunder: [
    {
      title: 'Thunder Clap',
      page: 'https://pixabay.com/de/sound-effects/film-spezialeffekte-thunder-clap-521194/',
      src: 'https://cdn.pixabay.com/download/audio/2026/04/17/audio_18fe74c15d.mp3?filename=u_q2hb2391vb-thunder-clap-521194.mp3',
    },
  ],
  rain: [
    {
      title: 'Rain Sound',
      page: 'https://pixabay.com/de/sound-effects/natur-rain-sound-188158/',
      src: 'https://cdn.pixabay.com/download/audio/2024/01/25/audio_b05a8ceddc.mp3?filename=boons_freak-rain-sound-188158.mp3',
    },
  ],
  rainThunder: [
    {
      title: 'Rain And Thunder',
      page: 'https://pixabay.com/de/sound-effects/natur-rain-and-thunder-197091/',
      src: 'https://cdn.pixabay.com/download/audio/2024/03/19/audio_abbbbb0634.mp3?filename=swifteditsmedia_online-rain-and-thunder-197091.mp3',
    },
  ],
  landslide: [
    {
      title: 'Whoosh 1',
      page: 'https://pixabay.com/de/sound-effects/film-spezialeffekte-whoosh-1-522923/',
      src: 'https://cdn.pixabay.com/audio/2026/04/21/audio_fb353da0c3.mp3',
    },
  ],
  construction: [
    {
      title: 'Construction_Site_Cat_1',
      page: 'https://pixabay.com/de/sound-effects/technologie-construction-site-cat-1-25502/',
      src: 'https://cdn.pixabay.com/audio/2022/03/09/audio_098c98eb02.mp3',
    },
  ],
};

export const COMMAND_VOICE_SAMPLES = {
  mixed: [
    { text: 'Alle Einheiten vorwaerts. Irgendwer wird schon wissen, warum.', src: '/client/assets/audio/voices/mixed-01.mp3' },
    { text: 'Bewegung! Das sieht fast nach einem Plan aus.', src: '/client/assets/audio/voices/mixed-02.mp3' },
    { text: 'Los jetzt, synchrones Chaos in Richtung Ziel.', src: '/client/assets/audio/voices/mixed-03.mp3' },
    { text: 'Bestaetigt. Alle hin, bitte mit Wuerde.', src: '/client/assets/audio/voices/mixed-04.mp3' },
  ],
  infantry: [
    { text: 'Zu Fuss unterwegs. Heute ist offenbar Beintag.', src: '/client/assets/audio/voices/infantry-01.mp3' },
    { text: 'Wir marschieren. Kaffee bitte ans Ziel schicken.', src: '/client/assets/audio/voices/infantry-02.mp3' },
    { text: 'Verstanden, wir nehmen die malerische Todesroute.', src: '/client/assets/audio/voices/infantry-03.mp3' },
    { text: 'Infanterie laeuft. Jammern erst nach Ankunft.', src: '/client/assets/audio/voices/infantry-04.mp3' },
  ],
  builder: [
    { text: 'Bagger rollt. Landschaft, bitte kurz die Luft anhalten.', src: '/client/assets/audio/voices/builder-01.mp3' },
    { text: 'Unterwegs. Ich bringe Schaufel und schlechte Laune.', src: '/client/assets/audio/voices/builder-02.mp3' },
    { text: 'Verstanden. Ich parke da gleich ein Loch.', src: '/client/assets/audio/voices/builder-03.mp3' },
    { text: 'Baugeraet faehrt. Der Boden hatte es kommen sehen.', src: '/client/assets/audio/voices/builder-04.mp3' },
  ],
  truck: [
    { text: 'LKW unterwegs. Ladung tut so, als waere sie gesichert.', src: '/client/assets/audio/voices/truck-01.mp3' },
    { text: 'Route gesetzt. Schlagloecher werden administrativ ignoriert.', src: '/client/assets/audio/voices/truck-02.mp3' },
    { text: 'Brumm brumm, Logistik mit Charakter.', src: '/client/assets/audio/voices/truck-03.mp3' },
    { text: 'Ich fahre los. Papierkram kommt spaeter.', src: '/client/assets/audio/voices/truck-04.mp3' },
  ],
  vehicle: [
    { text: 'Motor an. Wir machen Reifenspuren mit Absicht.', src: '/client/assets/audio/voices/vehicle-01.mp3' },
    { text: 'Panzer rollt. Bitte Ziel nicht schon wieder verschieben.', src: '/client/assets/audio/voices/vehicle-02.mp3' },
    { text: 'Verstanden. Wir fahren da professionell drueber.', src: '/client/assets/audio/voices/vehicle-03.mp3' },
    { text: 'Kette oder Reifen, Hauptsache vorwaerts.', src: '/client/assets/audio/voices/vehicle-04.mp3' },
  ],
  air: [
    { text: 'Kurs bestaetigt. Stau ist heute unter uns.', src: '/client/assets/audio/voices/air-01.mp3' },
    { text: 'Wir heben ab und tun wichtig.', src: '/client/assets/audio/voices/air-02.mp3' },
    { text: 'Fliegen los. Bodenprobleme sind jetzt optional.', src: '/client/assets/audio/voices/air-03.mp3' },
    { text: 'Ziel erfasst. Wolken machen bitte Platz.', src: '/client/assets/audio/voices/air-04.mp3' },
  ],
  water: [
    { text: 'Kurs gesetzt. Wellen bitte rechts ranfahren.', src: '/client/assets/audio/voices/water-01.mp3' },
    { text: 'Aye. Wasser ist schon mal vorhanden.', src: '/client/assets/audio/voices/water-02.mp3' },
    { text: 'Schiff unterwegs. Wir tun nautisch.', src: '/client/assets/audio/voices/water-03.mp3' },
    { text: 'Leinen los. Trockene Abkuerzungen sind untersagt.', src: '/client/assets/audio/voices/water-04.mp3' },
  ],
};
