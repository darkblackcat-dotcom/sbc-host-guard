const PREFIX = "hg-";

// k - ключ, t - название, d - описание, def/min/max/step - значения ползунка,
// scale - во сколько раз значение хранится больше (для дробных: 10 = один знак после запятой),
// unit - единица для подписи. bool: true - переключатель вместо ползунка.
const DEFS = [
    { h: "Античит: наказание" },
    { k: "base_seconds", t: "Время наказания за нарушение", d: "Наказание = номер нарушения × это число секунд", def: 60, min: 10, max: 600, step: 10, unit: " с" },
    { k: "return_first", t: "Возвратов без наказания", d: "Первые N нарушений игрока просто возвращают на место. 0 - наказывать сразу", def: 2, min: 0, max: 10, step: 1, unit: "" },
    { k: "pvp_ban_at", t: "Предупреждений до бана в PvP", d: "На каком нарушении в PvP выдаётся бан", def: 3, min: 1, max: 10, step: 1, unit: "" },
    { k: "pvp_punish", t: "Наказания в PvP", d: "Выключено: в PvP нарушителя только возвращают на место, без предупреждений и бана", bool: true, def: true },
    { k: "log_only", t: "Только лог, без наказаний", d: "Нарушения пишутся в чат и лог, наказания не выдаются", bool: true, def: false },

    { h: "Античит: чувствительность" },
    { k: "min_allowed", t: "Минимально допустимый рывок", d: "Меньше этого расстояния рывком не считается (юниты мира, 8 = 1 тайл)", def: 48, min: 48, max: 480, step: 8, unit: "" },
    { k: "lag_mult", t: "Запас по рывку (множитель)", d: "Чем больше, тем мягче проверка телепорта", def: 25, min: 10, max: 60, step: 1, scale: 10, unit: "x" },
    { k: "vel_mult", t: "Запас по скорости (множитель)", d: "Чем больше, тем мягче проверка ускорения", def: 15, min: 10, max: 30, step: 1, scale: 10, unit: "x" },
    { k: "grace_checks", t: "Проверок пропустить после смены юнита", d: "Защита от ложных срабатываний при смене юнита", def: 1, min: 1, max: 10, step: 1, unit: "" },
    { k: "check_ticks", t: "Интервал проверки", d: "Раз в сколько тиков проверять игроков (60 тиков = 1 секунда)", def: 12, min: 6, max: 60, step: 1, unit: " т" },

    { h: "Античит: лаги и возврат" },
    { k: "lag_frame_delta", t: "Порог лага кадра", d: "Кадр дольше этого числа тиков считается лагом, проверка пропускается", def: 2, min: 1, max: 10, step: 1, unit: " т" },
    { k: "lag_real_ms", t: "Запас по реальному времени", d: "Запас сверх интервала проверки, дольше которого считается лагом", def: 150, min: 0, max: 1000, step: 50, unit: " мс" },
    { k: "return_tolerance", t: "Допуск у точки возврата", d: "Насколько близко игрок должен встать к точке возврата (8 = 1 тайл)", def: 24, min: 8, max: 24, step: 4, unit: "" },
    { k: "return_settle", t: "Ожидание после возврата", d: "Сколько проверок ждать, пока клиент примет позицию", def: 20, min: 10, max: 30, step: 5, unit: "" },

    { h: "Режим новичка и журнал" },
    { k: "newbie_minutes", t: "Время новичка", d: "Сколько минут игрок считается новичком", def: 5, min: 0, max: 60, step: 1, unit: " мин" },
    { k: "auto_trust", t: "Авто-доверие после новичка", d: "Включено: после этого времени игрок становится доверенным до закрытия сервера", bool: true, def: true },
    { k: "log_max", t: "Размер журнала", d: "Сколько записей о постройках и разрушениях хранить", def: 5000, min: 500, max: 10000, step: 500, unit: "" },
    { k: "danger_radius", t: "Радиус опасных блоков у ядра", d: "В тайлах от ядра. Опасные блоки в этом радиусе ставят только хост и админы", def: 25, min: 0, max: 100, step: 1, unit: " т." },

    { h: "Прочее" },
    { k: "scan_ticks", t: "Интервал проверки процессоров", d: "Как часто антивирус сканирует процессоры (60 тиков = 1 секунда)", def: 120, min: 30, max: 600, step: 30, unit: " т" },
    { k: "msg_cooldown", t: "Пауза между сообщениями /votekick-защиты", d: "Минимум между сообщениями игроку о запрете", def: 2000, min: 500, max: 10000, step: 500, unit: " мс" },
    { k: "max_skip", t: "Максимум волн в /skip", d: "Сколько волн можно пропустить за раз", def: 5, min: 1, max: 10, step: 1, unit: "" },

    { k: "debug", t: "Отладка (подробный лог)", d: "Пишет в лог игры подробности работы мода: проверки античита, пропуски из-за лагов, антивирус", bool: true, def: false, bottom: true }
];

const BY_KEY = {};
DEFS.forEach(d => { if (d.k) BY_KEY[d.k] = d; });

function get(key) {
    const d = BY_KEY[key];
    if (d == null) throw "hgsettings: неизвестный ключ " + key;
    if (d.bool) return Core.settings.getBool(PREFIX + key, d.def);
    return Core.settings.getInt(PREFIX + key, d.def) / (d.scale || 1);
}

function label(d, v) {
    const n = Math.round(Number(v));
    const s = d.scale || 1;
    if (s == 1) return String(n) + d.unit;
    const whole = Math.floor(n / s);
    const frac = String(n % s);
    const pad = String(s).length - 1;
    return whole + "." + ("0000".substring(0, Math.max(0, pad - frac.length)) + frac) + d.unit;
}

const SettingCls = Packages.mindustry.ui.dialogs.SettingsMenuDialog$SettingsTable$Setting;
let customN = 0;

function customRow(t, build) {
    const name = "hg-custom-" + (customN++);
    const impl = { add: function(table) { build(table); } };
    let st;
    try {
        st = extend(SettingCls, name, impl);
    } catch (e) {
        st = new JavaAdapter(SettingCls, impl, name);
    }
    t.pref(st);
}

function build(t) {
    DEFS.forEach(d => {
        if (d.bottom) return;
        if (d.h) {
            customRow(t, table => table.add("[accent]" + d.h).padTop(12).padBottom(2).left().row());
            return;
        }
        if (d.bool) t.checkPref(PREFIX + d.k, d.def);
        else t.sliderPref(PREFIX + d.k, d.def, d.min, d.max, d.step, v => label(d, v));
    });

    DEFS.forEach(d => {
        if (d.bottom) t.checkPref(PREFIX + d.k, d.def);
    });
}

Events.on(ClientLoadEvent, () => {
    try {
        // названия и описания пунктов берутся из bundle по ключам setting.<имя>.name / .description
        const props = Core.bundle.getProperties();
        DEFS.forEach(d => {
            if (!d.k) return;
            props.put("setting." + PREFIX + d.k + ".name", d.t);
            props.put("setting." + PREFIX + d.k + ".description", d.d);
        });

        try {
            Vars.ui.settings.addCategory("HostGuard", Icon.admin, t => build(t));
        } catch (e) {
            Log.err("[hgsettings] раздел со значком не создался, делаю без него: " + e);
            Vars.ui.settings.addCategory("HostGuard", t => build(t));
        }
    } catch (e) {
        Log.err("[hgsettings] не удалось добавить меню настроек: " + e);
    }
});

function debug(msg) {
    try {
        if (get("debug")) Log.info("[HostGuard debug] " + msg);
    } catch (e) {}
}

module.exports = { get: get, debug: debug };
