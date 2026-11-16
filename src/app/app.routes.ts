import { HttpClient } from '@angular/common/http';
import { inject } from '@angular/core';
import { ResolveFn, Routes } from '@angular/router';
import { API, Project, User } from './api';
import { Home, Privacy, Profile, ProjectPage } from './pages';

const user: ResolveFn<User> = (route) =>
  inject(HttpClient).get<User>(`${API}/users/${route.params['user']}`);

const project: ResolveFn<Project> = (route) =>
  inject(HttpClient).get<Project>(
    `${API}/projects/${route.params['user']}/${route.params['project']}`,
  );

export const routes: Routes = [
  { path: '', component: Home, title: 'Projects' },
  { path: 'legal/privacy', component: Privacy, title: 'Privacy policy' },
  {
    path: ':user',
    component: Profile,
    resolve: { user },
    title: (route) => `Profile of ${route.params['user']}`,
  },
  {
    path: ':user/:project',
    component: ProjectPage,
    resolve: { project },
    title: (route) => `Project ${route.params['user']}/${route.params['project']}`,
  },
];
