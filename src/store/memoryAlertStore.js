// Repository pattern: routes talk to a "store" interface, not to an array or a DB.
// In Lesson 3 we add postgresAlertStore.js with the SAME methods and swap it in.
export function createMemoryAlertStore() {
  const alerts = [];
  let nextId = 1;                 // not alerts.length + 1: that breaks once we support delete

  return {
    async list({ status } = {}) {
      const result = status ? alerts.filter(a => a.status === status) : [...alerts];
      return result.reverse();    // newest first, same contract as the Postgres store
    },

    async get(id) {
      return alerts.find(a => a.id === id);
    },

    async create({ pod, reason, severity }) {
      const alert = { id: nextId++, pod, reason, severity, status: 'open', createdAt: new Date(), resolvedAt: null };
      alerts.push(alert);
      return alert;
    },

    async resolve(id) {
      const alert = alerts.find(a => a.id === id);
      if (!alert) return undefined;
      if (alert.status !== 'resolved') {          // idempotent: resolving twice is not an error
        alert.status = 'resolved';
        alert.resolvedAt = new Date();
      }
      return alert;
    },

    async isReady() {
      return true;                // the Postgres store will actually ping the DB here
    },
  };
}
