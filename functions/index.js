const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const DIFF_XP = { easy: 15, normal: 30, hard: 60 };
const XP_BASE = 100;
const DAILY_XP_MAX = 200;
const MAX_SERVER_LEVEL = 50;
const MAX_SERVER_COINS = 5000;

const CHARACTER_SKINS = [
  { id: "default", price: 0 },
  { id: "minami", price: 200 },
  { id: "blue", price: 200 },
  { id: "pink", price: 200 },
  { id: "dark", price: 200 },
  { id: "chihuahua", price: 200 },
  { id: "porongi", price: 200 },
  { id: "jjaigeunwoo", price: 300 }
];

const DEFAULT_PROFILE = {
  level: 1,
  xp: 0,
  coins: 0,
  equippedCharacterSkin: "default",
  ownedCharacterSkins: ["default"],
  moneyEggClaimed: false,
  handsomeEggClaimed: false,
  playerName: "모험가",
  motto: "✨ 오늘도 한 걸음씩!"
};

function requireUid(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required.");
  return request.auth.uid;
}

function todayKeyKst() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function assertDateKey(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new HttpsError("invalid-argument", "Invalid date.");
  }
  return date;
}

function questId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanText(text, max = 50) {
  if (typeof text !== "string") throw new HttpsError("invalid-argument", "Invalid text.");
  const value = text.trim();
  if (!value) throw new HttpsError("invalid-argument", "Empty text.");
  return value.slice(0, max);
}

function skinById(id) {
  return CHARACTER_SKINS.find((skin) => skin.id === id);
}

function cleanProfile(raw = {}) {
  const profile = { ...DEFAULT_PROFILE, ...raw };
  profile.level = Number.isFinite(+profile.level) ? Math.max(1, Math.floor(+profile.level)) : 1;
  profile.xp = Number.isFinite(+profile.xp) ? Math.max(0, Math.floor(+profile.xp)) : 0;
  profile.coins = Number.isFinite(+profile.coins) ? Math.max(0, Math.floor(+profile.coins)) : 0;
  profile.ownedCharacterSkins = Array.isArray(profile.ownedCharacterSkins)
    ? profile.ownedCharacterSkins.filter((id) => skinById(id))
    : ["default"];
  if (!profile.ownedCharacterSkins.includes("default")) profile.ownedCharacterSkins.unshift("default");
  if (!skinById(profile.equippedCharacterSkin) || !profile.ownedCharacterSkins.includes(profile.equippedCharacterSkin)) {
    profile.equippedCharacterSkin = "default";
  }
  profile.moneyEggClaimed = !!profile.moneyEggClaimed;
  profile.handsomeEggClaimed = !!profile.handsomeEggClaimed;
  if (typeof profile.playerName !== "string") profile.playerName = "모험가";
  if (typeof profile.motto !== "string") profile.motto = "✨ 오늘도 한 걸음씩!";
  return profile;
}

function hasInvalidEconomy(profile) {
  return profile.level > MAX_SERVER_LEVEL ||
    profile.coins > MAX_SERVER_COINS ||
    profile.xp >= profile.level * XP_BASE ||
    profile.ownedCharacterSkins.length > CHARACTER_SKINS.length;
}

function secureProfile(raw = {}) {
  const profile = cleanProfile(raw);
  if (!hasInvalidEconomy(profile)) return { profile, reset: false };
  return {
    profile: cleanProfile({
      ...DEFAULT_PROFILE,
      playerName: profile.playerName,
      motto: profile.motto
    }),
    reset: true
  };
}

function profileRef(uid) {
  return db.doc(`users/${uid}/private/profile`);
}

function dayRef(uid, date) {
  return db.doc(`users/${uid}/questDays/${date}`);
}

async function ensureProfile(uid, tx) {
  const ref = profileRef(uid);
  const snap = await tx.get(ref);
  if (snap.exists) {
    const { profile, reset } = secureProfile(snap.data());
    if (reset) {
      tx.set(ref, {
        ...profile,
        securityResetAt: admin.firestore.FieldValue.serverTimestamp(),
        securityResetReason: "invalid-economy"
      }, { merge: true });
    }
    return { ref, profile };
  }
  const profile = cleanProfile(DEFAULT_PROFILE);
  tx.set(ref, { ...profile, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  return { ref, profile };
}

function applyXp(profile, amount) {
  profile.xp += amount;
  let levelRewardCoins = 0;
  while (profile.xp >= profile.level * XP_BASE) {
    profile.xp -= profile.level * XP_BASE;
    profile.level += 1;
    const reward = profile.level * 5 + 10;
    profile.coins += reward;
    levelRewardCoins += reward;
  }
  return levelRewardCoins;
}

exports.ensureUserProfile = onCall(async (request) => {
  const uid = requireUid(request);
  const result = await db.runTransaction(async (tx) => {
    const { profile } = await ensureProfile(uid, tx);
    return profile;
  });
  return { profile: result };
});

exports.addQuest = onCall(async (request) => {
  const uid = requireUid(request);
  const date = assertDateKey(request.data.date);
  if (date < todayKeyKst()) throw new HttpsError("failed-precondition", "Past quests cannot be created.");
  const text = cleanText(request.data.text, 50);
  const diff = request.data.diff;
  if (!DIFF_XP[diff]) throw new HttpsError("invalid-argument", "Invalid difficulty.");

  return db.runTransaction(async (tx) => {
    const ref = dayRef(uid, date);
    const snap = await tx.get(ref);
    const items = snap.exists && Array.isArray(snap.data().items) ? snap.data().items : [];
    const nextItems = [...items, { id: questId(), text, diff, done: false, xpAwarded: null }];
    tx.set(ref, { items: nextItems, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { items: nextItems };
  });
});

exports.deleteQuest = onCall(async (request) => {
  const uid = requireUid(request);
  const date = assertDateKey(request.data.date);
  if (date < todayKeyKst()) throw new HttpsError("failed-precondition", "Past quests cannot be deleted.");
  const id = cleanText(request.data.questId, 80);

  return db.runTransaction(async (tx) => {
    const ref = dayRef(uid, date);
    const snap = await tx.get(ref);
    const items = snap.exists && Array.isArray(snap.data().items) ? snap.data().items : [];
    const target = items.find((item) => item.id === id);
    if (!target) throw new HttpsError("not-found", "Quest not found.");
    if (target.done) throw new HttpsError("failed-precondition", "Completed quests cannot be deleted.");
    const nextItems = items.filter((item) => item.id !== id);
    tx.set(ref, { items: nextItems, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { items: nextItems };
  });
});

exports.completeQuest = onCall(async (request) => {
  const uid = requireUid(request);
  const date = assertDateKey(request.data.date);
  if (date > todayKeyKst()) throw new HttpsError("failed-precondition", "Future quests cannot be completed.");
  const id = cleanText(request.data.questId, 80);

  return db.runTransaction(async (tx) => {
    const { ref: profileDoc, profile } = await ensureProfile(uid, tx);
    const ref = dayRef(uid, date);
    const snap = await tx.get(ref);
    const items = snap.exists && Array.isArray(snap.data().items) ? snap.data().items : [];
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) throw new HttpsError("not-found", "Quest not found.");
    if (items[index].done) throw new HttpsError("failed-precondition", "Quest already completed.");

    const amount = DIFF_XP[items[index].diff] || 0;
    const earned = items.reduce((sum, item) => item.done ? sum + (item.xpAwarded || 0) : sum, 0);
    const awardedXp = earned + amount > DAILY_XP_MAX ? 0 : amount;
    items[index] = { ...items[index], done: true, xpAwarded: awardedXp, completedAt: Date.now() };
    const levelRewardCoins = applyXp(profile, awardedXp);

    tx.set(ref, { items, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    tx.set(profileDoc, { ...profile, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { profile, items, awardedXp, levelRewardCoins };
  });
});

exports.buySkin = onCall(async (request) => {
  const uid = requireUid(request);
  const skin = skinById(request.data.skinId);
  if (!skin) throw new HttpsError("invalid-argument", "Invalid skin.");

  return db.runTransaction(async (tx) => {
    const { ref, profile } = await ensureProfile(uid, tx);
    if (!profile.ownedCharacterSkins.includes(skin.id)) {
      if (profile.coins < skin.price) throw new HttpsError("failed-precondition", "Not enough coins.");
      profile.coins -= skin.price;
      profile.ownedCharacterSkins.push(skin.id);
    }
    profile.equippedCharacterSkin = skin.id;
    tx.set(ref, { ...profile, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { profile };
  });
});

exports.equipSkin = onCall(async (request) => {
  const uid = requireUid(request);
  const skin = skinById(request.data.skinId);
  if (!skin) throw new HttpsError("invalid-argument", "Invalid skin.");

  return db.runTransaction(async (tx) => {
    const { ref, profile } = await ensureProfile(uid, tx);
    if (!profile.ownedCharacterSkins.includes(skin.id)) {
      throw new HttpsError("failed-precondition", "Skin is not owned.");
    }
    profile.equippedCharacterSkin = skin.id;
    tx.set(ref, { ...profile, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { profile };
  });
});

exports.updateProfileText = onCall(async (request) => {
  const uid = requireUid(request);
  const playerName = typeof request.data.playerName === "string" ? request.data.playerName.trim().slice(0, 20) : null;
  const motto = typeof request.data.motto === "string" ? request.data.motto.trim().slice(0, 40) : null;

  return db.runTransaction(async (tx) => {
    const { ref, profile } = await ensureProfile(uid, tx);
    let eggMessage = "";
    if (playerName) {
      profile.playerName = playerName;
      if (playerName === "돈내놔" && !profile.moneyEggClaimed) {
        profile.coins += 200;
        profile.moneyEggClaimed = true;
        eggMessage = "이스터에그 발견! +200 코인";
      }
      if (playerName === "최수민존잘" && !profile.handsomeEggClaimed) {
        profile.coins += 2000;
        profile.handsomeEggClaimed = true;
        eggMessage = "이스터에그 발견! +2000 코인";
      }
    }
    if (motto) profile.motto = motto;
    tx.set(ref, { ...profile, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { profile, eggMessage };
  });
});
