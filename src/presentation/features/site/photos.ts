import type { DayMoment } from '@/application/site'
import type { MenuCategory } from '@/domain/serviceOrder'

/**
 * Photography for the public site, hotlinked from Unsplash under the Unsplash License. The console
 * keeps no property photos yet, so these stand in: they show Bali villas, food and places like ours,
 * not our own rooms. Each one names its photographer and its Unsplash page for the credits.
 */
export interface Photo {
  /** The images.unsplash.com id after "photo-". */
  id: string
  alt: string
  by: string
  page: string
}

const photo = (id: string, alt: string, by: string, slug: string): Photo => ({ id, alt, by, page: `https://unsplash.com/photos/${slug}` })

/** An Unsplash image cut to `width`, compressed and in the best format the browser takes. */
export const photoUrl = (p: Photo, width: number) => `https://images.unsplash.com/photo-${p.id}?w=${width}&q=75&auto=format&fit=crop`
export const photoSrcSet = (p: Photo, widths: readonly number[] = [480, 800, 1200, 1800]) => widths.map((w) => `${photoUrl(p, w)} ${w}w`).join(', ')

const P = {
  twilight: photo('1759372945658-1e9f56e751bd', 'A tropical villa and its pool lit up at twilight', 'kadek wahyudi', 'tropical-villa-with-pool-at-twilight-oVnKC7wiQjA'),
  whiteVilla: photo('1613977257592-4871e5fcd7c4', 'A white villa with a long pool and an outdoor lounge', 'John Fornander', 'modern-white-villa-with-swimming-pool-tVzyDSV84w8'),
  poolTable: photo('1692736933760-8a8a9b8c1b6f', 'A private pool with a table and chairs on the deck', 'Shawn', 'a-pool-with-a-table-and-chairs-next-to-it-A7Z5U6LyacA'),
  poolUmbrellas: photo('1675657144285-7daf131132de', 'Lounge chairs and umbrellas along a garden pool', 'Nerissa J', 'a-pool-with-lounge-chairs-and-umbrellas-next-to-it-4jpU5xBQFqA'),
  tealBedroom: photo('1611892440504-42a792e24d32', 'A bedroom with a wooden bed and teal pillows opening onto a garden', 'visualsofdana', 'T5pL6ciEn-I'),
  poolChair: photo('1720161263981-84281892ee4b', 'A chair and table beside a small pool among palms', 'Pepita Martasya', 'a-pool-with-a-chair-and-a-table-next-to-it-OaQ-p0lCmRs'),
  courtyard: photo('1761521456079-1b513aec0add', 'A Balinese courtyard with carved stone and dense green planting', 'Nicole Arango Lang', 'traditional-balinese-courtyard-with-lush-greenery-and-architecture-SYduekkhTdA'),
  pondGarden: photo('1778500442208-603b3069a07d', 'A garden pond in front of a building with a tiled roof', 'Vidit Goswami', 'tranquil-garden-with-a-pond-and-tiled-roof-building-cNoKDcxUOXM'),
  riceHut: photo('1546845776-dcdf70fd09e3', 'A small thatched hut at the edge of a rice field', 'Darcey Beau', 'white-and-brown-hut-near-rice-field-and-trees-during-daytime-70zt5R19Bfk'),
  whiteBed: photo('1613553474179-e1eda3ea5734', 'A white bed facing a glass sliding door', 'Marvin Meyer', 'fBdlytm6Hp8'),
  loungePool: photo('1675657144361-98ae33e6b6f9', 'A long pool with a single lounge chair on the deck', 'Nerissa J', 'a-large-pool-with-a-lounge-chair-next-to-it-qawgWgMATzQ'),
  livingRoom: photo('1675657144140-31169b7e3848', 'A living room with low furniture and a tall window', 'Nerissa J', 'clzNiSBuVAM'),
  chaise: photo('1721222204632-bf9abe6f023f', 'Two chaise longues side by side at the edge of a pool', 'Sanju Pandita', 'a-couple-of-chaise-lounge-chairs-sitting-next-to-a-pool-S-7g_8S8cec'),
  madeBed: photo('1718894071528-1108a094cc78', 'A made bed and a small table in a bright room', 'Sanju Pandita', 'TKDF5G6ua1w'),
  cliff: photo('1759661323897-f48700499b33', 'A cliff-top pool above the ocean with waves below', 'Merve Kalafat Yılmaz', 'wUwWdcua7hI'),
  bench: photo('1520250497591-112f2f40a3f4', 'A wooden bench beside a pool under palm trees', 'Sara Dubler', 'photo-of-brown-bench-near-swimming-pool-Koei_7yYtIo'),
  starPool: photo('1639098376571-bdca431efaee', 'A villa and its pool at night under a sky full of stars', 'Woody Kelly', 'a-night-time-view-of-a-house-with-a-pool-and-stars-in-the-sky-IGtSCUQzMuo'),
  roomBed: photo('1651108066208-c5ee56cdffc7', 'A bed with white linen in a calm room', 'Alexander Davies', '3jZd5h4nJDE'),
  house: photo('1688653802629-5360086bf632', 'A house with a sloping roof behind a garden wall', 'Don Kaveen', 'a-house-with-a-car-parked-in-front-of-it-4LLHJHyXQVk'),
  litPool: photo('1750271329214-a7dbce880e85', 'A pool and house lit up at night', 'sidath vimukthi', 'a-lit-up-pool-and-house-at-night-4bW1uBe4KJc'),
  dawnTerraces: photo('1558005530-a7958896ec60', 'A walker on green rice terraces below a misty mountain at dawn', 'Geio Tischler', 'person-walking-through-green-rice-terraces-7hww7t6NLcg'),
  breakfast: photo('1783347555848-a4012d96738d', 'A breakfast table with fresh juice, sliced fruit and warm dishes', 'Nilshan Sandaruwan', 'breakfast-table-with-fresh-juice-sliced-fruit-and-traditional-dishes-DW1W4rVpwVA'),
  friedRice: photo('1542095496-1ee6599fe563', 'Fried rice with a fried egg and glasses of juice', 'Ariv Kurniawan', 'fried-rice-and-glass-of-juices-on-table-n_C8KBRI5zc'),
  stoneMassage: photo('1600334129128-685c5582fd35', 'A hot stone massage with white flowers on the table', 'engin akyurt', 'SMwCQZWayj0'),
  seaTemple: photo('1766854269605-bd06cb72217e', 'A temple on a rock arch over the sea at sunset', 'Ishaan Sen', 'OQRkj2erTPI'),
  palmSunset: photo('1616484173745-07f25fd0547f', 'Palm trees in silhouette against an orange sunset over the water', 'Muhammad Novrijal', 'G7Ch00h8Ong'),
  nightPool: photo('1775667447327-16d590d63180', 'A glowing pool at night ringed by palm trees', 'Ahmet Yüksek', 'a-glowing-swimming-pool-at-night-surrounded-by-palm-trees-fN_FfsOGWOo'),
  massage: photo('1600334089648-b0d9d3028eb2', 'Smooth black stones laid along a back on a massage table', 'engin akyurt', 'ZbzYDboN7fg'),
  tegallalang: photo('1555400038-63f5ba517a47', 'Rice terraces and palm trees at Tegallalang', 'Niklas Weiss', 'rice-terraces-in-tegelalang-bali--2WlTWZLnRc'),
  aerialTerraces: photo('1559628233-eb1b1a45564b', 'Rice terraces seen from above', 'Silas Baisch', 'aerial-photography-of-rice-terraces-during-daytime-rf5R1qXwlDU'),
  feast: photo('1728050829024-8113f4cd85ec', 'A table set with plates of food and drinks', 'Antonio Araujo', 'xyel_GFkqh4'),
  archway: photo('1712226652059-a34d334e6cd0', 'A couch under a white archway next to a pool', 'Raajit Sharma', 'S7TZKe2ktSU'),
} satisfies Record<string, Photo>

export const HERO_PHOTO = P.twilight
export const INTRO_PHOTO = P.archway
export const CLOSING_PHOTO = P.palmSunset

/** A hero and a gallery per villa id. */
const VILLA_PHOTOS: Record<string, { hero: Photo; gallery: readonly Photo[] }> = {
  'vil-saka': { hero: P.poolTable, gallery: [P.poolTable, P.poolUmbrellas, P.tealBedroom, P.poolChair, P.friedRice] },
  'vil-tirta': { hero: P.courtyard, gallery: [P.courtyard, P.pondGarden, P.riceHut, P.whiteBed, P.stoneMassage] },
  'vil-lumbung': { hero: P.loungePool, gallery: [P.loungePool, P.livingRoom, P.chaise, P.madeBed, P.feast] },
  'vil-karang': { hero: P.cliff, gallery: [P.cliff, P.bench, P.starPool, P.roomBed, P.seaTemple] },
  'vil-pandawa': { hero: P.whiteVilla, gallery: [P.whiteVilla, P.house, P.litPool] },
}
const FALLBACK = { hero: P.whiteVilla, gallery: [P.whiteVilla, P.litPool, P.bench] }
export const villaPhotos = (villaId: string) => VILLA_PHOTOS[villaId] ?? FALLBACK

export const DAY_PHOTOS: Record<DayMoment, Photo> = { morning: P.dawnTerraces, breakfast: P.breakfast, afternoon: P.stoneMassage, sunset: P.seaTemple, night: P.nightPool }

export const EXPERIENCE_PHOTOS: Partial<Record<MenuCategory, Photo>> = { spa: P.massage, tours: P.tegallalang, transport: P.aerialTerraces, food: P.feast }

/** Every photo once, in the order the credits list them. */
export const CREDITS: readonly Photo[] = Object.values(P)
