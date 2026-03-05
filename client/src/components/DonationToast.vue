<script>
import { pingViewers, fetchDonations } from '@/composables/useApi.js';
const POLL_INTERVAL_MS = 25000;
const TOAST_TTL_MS = 6000;
const NOTE_MAX_LEN = 120;
const STORAGE_KEY_LAST_SEEN = 'donationToastLastSeenId';

function getStoredLastSeenId() {
  try {
    const v = localStorage.getItem(STORAGE_KEY_LAST_SEEN);
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export default {
  name: 'DonationToast',
  data() {
    return {
      toasts: [],
      lastSeenId: getStoredLastSeenId(),
      pollTimer: null,
    };
  },
  mounted() {
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  },
  beforeUnmount() {
    if (this.pollTimer) clearInterval(this.pollTimer);
  },
  methods: {
    getViewerId() {
      try {
        return localStorage.getItem('viewerId') || '';
      } catch {
        return '';
      }
    },
    persistLastSeenId(id) {
      try {
        localStorage.setItem(STORAGE_KEY_LAST_SEEN, String(id));
      } catch (_) {}
    },
    async poll() {
      const viewerId = this.getViewerId();
      if (!viewerId) return;
      try {
        const ping = await pingViewers(viewerId, { lastDonationId: this.lastSeenId });
        if (!ping?.hasNewDonations) return;
        const data = await fetchDonations(this.lastSeenId);
        const list = data.donations || [];
        if (!list.length) return;
        let maxId = this.lastSeenId;
        for (const d of list) {
          if (d.id > maxId) maxId = d.id;
          this.toasts.push({
            id: d.id,
            name: d.name || 'Someone',
            note: d.note || '',
            amount: d.amount,
            currency: d.currency || 'USD',
            dismissAt: Date.now() + TOAST_TTL_MS,
          });
        }
        this.lastSeenId = maxId;
        this.persistLastSeenId(maxId);
        this.scheduleDismiss();
      } catch (_) {}
    },
    scheduleDismiss() {
      const now = Date.now();
      this.toasts = this.toasts.filter((t) => t.dismissAt > now);
      const next = this.toasts.reduce((min, t) => (t.dismissAt < min ? t.dismissAt : min), Infinity);
      if (next !== Infinity && this.toasts.length) {
        setTimeout(() => this.scheduleDismiss(), Math.max(100, next - now));
      }
    },
    dismiss(id) {
      this.toasts = this.toasts.filter((t) => t.id !== id);
    },
    addFakeToast() {
      const id = 'fake-' + Date.now();
      this.toasts.push({
        id,
        name: 'Debug Donor',
        note: 'This is a fake toast for UI debugging. is a fake toast for UI debugging is a fake toast for UI debugging is a fake toast for UI debugging is a fake toast for UI debugging is a fake toast for UI debugging',
        amount: 5,
        currency: 'USD',
        dismissAt: Date.now() + TOAST_TTL_MS,
      });
      this.scheduleDismiss();
    },
    formatAmount(amount, currency) {
      if (amount == null) return '';
      const n = Number(amount);
      if (currency === 'USD') return `$${n.toFixed(2)}`;
      return `${n.toFixed(2)} ${currency}`;
    },
    truncateNote(note) {
      if (!note) return '';
      const s = String(note).trim();
      if (s.length <= NOTE_MAX_LEN) return s;
      return s.slice(0, NOTE_MAX_LEN) + '...';
    },
  },
};
</script>
<template>
  <div class="donation-toast-container" aria-live="polite">
    <transition-group name="toast-slide">
      <div
          v-for="t in toasts"
          :key="t.id"
          class="donation-toast"
          role="status"
      >
        <div class="donation-toast-accent"></div>
        <div class="donation-toast-body">
          <div class="donation-toast-header">
            <div class="donation-toast-title">
              <span class="donation-toast-name">{{ t.name }}</span>
            </div>
            <button
                type="button"
                class="donation-toast-close"
                aria-label="Dismiss notification"
                @click="dismiss(t.id)"
            >
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
          <p v-if="t.note" class="donation-toast-note">{{ truncateNote(t.note) }}</p>
          <div class="donation-toast-footer">
            <span class="donation-toast-amount">{{ formatAmount(t.amount, t.currency) }}</span>
          </div>
        </div>
      </div>
    </transition-group>
  </div>
</template>
<style scoped>
.donation-toast-container {
  position: fixed;
  bottom: 1.25rem;
  right: 1rem;
  z-index: 50;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  max-width: min(330px, calc(100vw - 2rem));
  pointer-events: none;
}
.donation-toast-container > * {
  pointer-events: auto;
}
[dir="rtl"] .donation-toast-container {
  right: auto;
  left: 1rem;
}

.toast-slide-enter-active {
  transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1);
}
.toast-slide-leave-active {
  transition: all 0.25s ease-in;
}
.toast-slide-enter-from {
  opacity: 0;
  transform: translateY(16px) scale(0.95);
}
.toast-slide-leave-to {
  opacity: 0;
  transform: translateX(24px) scale(0.95);
}

.donation-toast {
  border-radius: 14px;
  overflow: hidden;
  display: flex;
  border: 1px solid rgba(255, 221, 0, 0.15);
  background: linear-gradient(
      135deg,
      rgba(28, 25, 55, 0.94) 0%,
      rgba(35, 30, 65, 0.96) 100%
  );
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow:
      0 8px 32px rgba(0, 0, 0, 0.4),
      inset 0 1px 0 rgba(255, 221, 0, 0.05);
}

.donation-toast-accent {
  width: 4px;
  flex-shrink: 0;
  background: linear-gradient(180deg, #ffdd00 0%, #e6c700 100%);
  border-radius: 14px 0 0 14px;
}

[dir="rtl"] .donation-toast-accent {
  border-radius: 0 14px 14px 0;
}

.donation-toast-body {
  padding: 0.85rem 1rem;
  flex: 1;
  min-width: 0;
}

.donation-toast-header {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  margin-bottom: 0.3rem;
}

.donation-toast-icon {
  width: 1.7rem;
  height: 1.7rem;
  flex-shrink: 0;
  color: #ffdd00;
}

.donation-toast-title {
  display: flex;
  flex-direction: column;
  gap: 0.05rem;
  min-width: 0;
  flex: 1;
}

.donation-toast-name {
  font-weight: 700;
  font-size: 0.88rem;
  color: #ffdd00;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.donation-toast-label {
  font-size: 0.72rem;
  color: rgba(255, 221, 0, 0.45);
  font-weight: 500;
  line-height: 1.2;
}

.donation-toast-close {
  padding: 0.25rem;
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.3);
  cursor: pointer;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s, background 0.15s;
  flex-shrink: 0;
}
.donation-toast-close svg {
  width: 0.8rem;
  height: 0.8rem;
}
.donation-toast-close:hover {
  color: rgba(255, 255, 255, 0.8);
  background: rgba(255, 255, 255, 0.06);
}
.donation-toast-close:focus-visible {
  outline: 2px solid rgba(255, 221, 0, 0.5);
  outline-offset: 2px;
}

.donation-toast-note {
  font-size: 0.78rem;
  color: rgba(230, 228, 245, 0.65);
  margin: 0 0 0.4rem 0;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
  padding-left: 2.25rem;
}

[dir="rtl"] .donation-toast-note {
  padding-left: 0;
  padding-right: 2.25rem;
}

.donation-toast-footer {
  padding-left: 2.25rem;
}

[dir="rtl"] .donation-toast-footer {
  padding-left: 0;
  padding-right: 2.25rem;
}

.donation-toast-amount {
  font-size: 0.92rem;
  font-weight: 800;
  color: #ffdd00;
  margin: 0;
}
</style>