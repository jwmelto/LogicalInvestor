// Metro always defines this at bundle time (literal true/false) in every real build, dev or
// production. Jest has no equivalent bundler step, so without this, any code that references
// __DEV__ throws ReferenceError in tests — define it once here instead of ordering conditionals
// around the gap at every call site.
global.__DEV__ = true;
