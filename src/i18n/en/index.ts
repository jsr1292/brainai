/** The English catalog (the source): one file per area, merged here. Every area has its file and its line already; workers never edit this index. */
import { common } from './common.js';
import { language } from './language.js';
import { shell } from './shell.js';
import { inbox } from './inbox.js';
import { settings } from './settings.js';
import { setup } from './setup.js';
import { projects } from './projects.js';
import { review } from './review.js';
import { data } from './data.js';
import { auth } from './auth.js';
import { discussions } from './discussions.js';
import { skills } from './skills.js';
import { client } from './client.js';
import { errPages } from './errPages.js';
import { errProjects } from './errProjects.js';
import { errSkills } from './errSkills.js';
import { errTidy } from './errTidy.js';
import { errDisc } from './errDisc.js';

export const en = { ...common, ...language, ...shell, ...inbox, ...settings, ...setup, ...projects, ...review, ...data, ...auth, ...discussions, ...skills, ...client, ...errPages, ...errProjects, ...errSkills, ...errTidy, ...errDisc } as const;
