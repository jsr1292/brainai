/** The Spanish (Spain) catalog: one file per area, merged here, each typed to have every key of its English file. */
import type { en } from '../en/index.js';
import type { Entry } from '../core.js';
import { common_es } from './common.js';
import { language_es } from './language.js';
import { shell_es } from './shell.js';
import { inbox_es } from './inbox.js';
import { settings_es } from './settings.js';
import { setup_es } from './setup.js';
import { projects_es } from './projects.js';
import { review_es } from './review.js';
import { data_es } from './data.js';
import { auth_es } from './auth.js';
import { discussions_es } from './discussions.js';
import { skills_es } from './skills.js';
import { client_es } from './client.js';
import { errPages_es } from './errPages.js';
import { errProjects_es } from './errProjects.js';
import { errSkills_es } from './errSkills.js';
import { errTidy_es } from './errTidy.js';
import { errDisc_es } from './errDisc.js';

export const es: Record<keyof typeof en, Entry> = { ...common_es, ...language_es, ...shell_es, ...inbox_es, ...settings_es, ...setup_es, ...projects_es, ...review_es, ...data_es, ...auth_es, ...discussions_es, ...skills_es, ...client_es, ...errPages_es, ...errProjects_es, ...errSkills_es, ...errTidy_es, ...errDisc_es };
