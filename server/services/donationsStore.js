const MAX_DONATIONS = 5;
const store = [];
let nextId = 1;

function addDonation({ name, note, amount, currency }) {
    const id = nextId++;
    store.push({ id, name, note, amount, currency: currency || 'USD' });
    if (store.length > MAX_DONATIONS) store.shift();
    return id;
}

function getSince(afterId) {
    const after = parseInt(afterId, 10) || 0;
    return store.filter((d) => d.id > after);
}

function hasNewSince(afterId) {
    const after = parseInt(afterId, 10) || 0;
    return store.some((d) => d.id > after);
}

module.exports = { addDonation, getSince, hasNewSince };
