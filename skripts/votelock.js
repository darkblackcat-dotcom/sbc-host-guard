// votelock.js — игроку, на которого идёт встроенное голосование (/votekick),
// запрещено строить и ломать блоки, пока голосование не закончится.
// Работает только при включённом античите.

const ac = require("anticheat");

const MSG_COOLDOWN = 2000; // мс между сообщениями игроку

const AT = Packages.mindustry.net.Administration$ActionType;
let lastMsg = 0;
let warned = false;

// Игрок, на которого сейчас идёт голосование (или null)
function voteTarget() {
    try {
        const R = Packages.arc.util.Reflect;
        const arr = R.get(Vars.netServer, "currentlyKicking");
        if (arr == null || arr[0] == null) return null;
        return R.get(arr[0], "target");
    } catch (e) {
        if (!warned) {
            warned = true;
            Log.err("[votelock] не удалось прочитать данные голосования: " + e);
        }
        return null;
    }
}

Vars.netServer.admins.addActionFilter(action => {
    if (!ac.isEnabled()) return true;
    if (action.type != AT.placeBlock && action.type != AT.breakBlock) return true;

    const p = action.player;
    if (p == null) return true;

    const target = voteTarget();
    if (target == null || target.uuid() != p.uuid()) return true;

    const now = Time.millis();
    if (now - lastMsg > MSG_COOLDOWN) {
        lastMsg = now;
        p.sendMessage("[scarlet]Пока идёт голосование против тебя, строить нельзя.");
    }
    return false;
});

