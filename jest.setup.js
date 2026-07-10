// Metro always defines this at bundle time; Jest has no equivalent step, so code referencing
// __DEV__ throws ReferenceError in tests without this.
global.__DEV__ = true;
