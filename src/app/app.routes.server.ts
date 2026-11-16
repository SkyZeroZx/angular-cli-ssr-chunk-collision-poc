import { RenderMode, ServerRoute } from '@angular/ssr';
import { API, Project, User } from './api';

const list = async <T>(what: string): Promise<T[]> => (await fetch(`${API}/${what}`)).json();

// Both functions below are the workaround published in GHSA-w34w-96hf-98hj: fetch the items, keep the
// ones that match its allowlist, map them to parameters.
const SLUG = /^[a-zA-Z0-9-_]+$/;

export const serverRoutes: ServerRoute[] = [
  {
    path: ':user',
    renderMode: RenderMode.Prerender,
    getPrerenderParams: async () => {
      const users = await list<User>('users');
      return users.filter((item) => SLUG.test(item.name)).map((item) => ({ user: item.name }));
    },
  },
  {
    path: ':user/:project',
    renderMode: RenderMode.Prerender,
    getPrerenderParams: async () => {
      const projects = await list<Project>('projects');
      return projects
        .filter((item) => SLUG.test(item.user) && SLUG.test(item.name))
        .map((item) => ({ user: item.user, project: item.name }));
    },
  },
  { path: '**', renderMode: RenderMode.Prerender },
];
