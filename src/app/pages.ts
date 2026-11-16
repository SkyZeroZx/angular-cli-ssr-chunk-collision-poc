import { Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Project, User } from './api';

@Component({
  template: `<h1>Projects</h1>
    <p>Open-source projects and the people who maintain them.</p>`,
})
export class Home {}

// A page of the site itself. Nothing in it comes from the record store.
@Component({
  template: `<h1>Privacy policy</h1>
    @for (section of sections; track section) {
      <h2>{{ section }}</h2>
      <p>
        We process personal data only as described in this policy and never sell it. You can ask for
        a copy of your data, or for its deletion, by writing to privacy&#64;example.test.
      </p>
    }`,
})
export class Privacy {
  protected readonly sections = [
    'What we collect',
    'Why we collect it',
    'How long we keep it',
    'Who we share it with',
    'Cookies',
    'Your rights',
    'Changes to this policy',
    'Contact',
  ];
}

@Component({
  template: `<h1>{{ user.name }}</h1>
    <p>{{ user.bio }}</p>
    <a [href]="user.website">Website</a>`,
})
export class Profile {
  protected readonly user = inject(ActivatedRoute).snapshot.data['user'] as User;
}

@Component({
  template: `<h1>{{ project.user }} / {{ project.name }}</h1>
    <p>{{ project.description }}</p>`,
})
export class ProjectPage {
  protected readonly project = inject(ActivatedRoute).snapshot.data['project'] as Project;
}
