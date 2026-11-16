// The record store (store.mjs). The build reads it in getPrerenderParams, the pages read it when they render.
export const API = 'http://127.0.0.1:4400';

export interface User {
  name: string;
  bio: string;
  website: string;
}

export interface Project {
  user: string;
  name: string;
  description: string;
}
