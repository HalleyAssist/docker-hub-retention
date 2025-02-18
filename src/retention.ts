/** @format */

import { getInput, info, setFailed } from '@actions/core';
import { DockerRegistry, type DockerTag } from './docker';
import { parseISO, subDays, subMonths, subYears } from 'date-fns';
import { parse } from 'yaml';

process.on('uncaughtException', (e) => info(`warning: ${e.message}`));

const retentionToDate = (retention: string): Date => {
  const retentionMatch = retention.match(/^([0-9]+)([dmy])$/);
  if (retentionMatch) {
    const [, value, unit] = retentionMatch;
    const date = new Date();
    switch (unit) {
      case 'd':
        return subDays(date, Number(value));
      case 'm':
        return subMonths(date, Number(value));
      case 'y':
        return subYears(date, Number(value));
      default:
        throw new Error(`invalid retention unit: ${unit}`);
    }
  }
  throw new Error(`invalid retention format: ${retention}`);
};

async function dockerRegistryRetention() {
  try {
    const repository = getInput('repository', { required: true });
    const username = getInput('username', { required: false });
    const password = getInput('password', { required: false });
    const match = getInput('match', { required: false });
    const retention = getInput('retention', { required: false });
    const multiple = getInput('multiple', { required: false });
    const unless = getInput('unless', { required: false });
    const dryRun = getInput('dryrun', { required: false }) === 'true';
    const minimum = getInput('minimum', { required: false });

    const config: { match: string; retention: string; minimum: string }[] = [];

    if (multiple) {
      const multipleConfig = parse(multiple);
      if (!Array.isArray(multipleConfig)) {
        throw new Error('multiple config must be an array');
      }
      for (const entry of multipleConfig) {
        if (entry.match && entry.retention) {
          config.push(entry);
        } else {
          throw new Error('multiple config must contain match and retention');
        }
      }
    } else {
      config.push({ match, retention, minimum });
    }

    let unlessConfig = [];
    if (unless) {
      unlessConfig = parse(unless);
      if (!Array.isArray(unlessConfig)) {
        throw new Error('unless config must be an array');
      }
    }

    info(`repository: ${repository}`);
    info(`config: ${JSON.stringify(config)}`);

    try {
      const client = new DockerRegistry({ repository });

      if (username && password) {
        await client.login(username, password);
      }

      let tags = await client.getTags();
      const toDelete: DockerTag[] = [];

      const unlessImages: string[] = [];
      for (const { match } of unlessConfig) {
        const matchingTags = tags.filter((tag) => (match ? !!tag.name.match(match) : true));
        for (const tag of matchingTags) {
          unlessImages.push(...tag.images.map((i) => i.digest));
        }
      }

      for (const { match, retention, minimum } of config) {
        const retentionDate = retentionToDate(retention);

        let matchingTags = tags.filter((tag) => (match ? !!tag.name.match(match) : true));

        // remove any matching tags where at-least one image is in the unless list
        matchingTags = matchingTags.filter((tag) => {
          return !tag.images.some((i) => unlessImages.includes(i.digest));
        });

        // sort tags in decending order
        matchingTags.sort((a, b) => parseISO(b.tag_last_pushed).getTime() - parseISO(a.tag_last_pushed).getTime());

        // if minimum is set remove the first n tags
        if (minimum) {
          const minimumTags = matchingTags.splice(0, Number(minimum));
          info(`removing the first ${minimumTags.length} tags`);
        }

        toDelete.push(
          ...matchingTags.filter((tag) => {
            return parseISO(tag.tag_last_pushed) < retentionDate && parseISO(tag.tag_last_pulled) < retentionDate;
          }),
        );
      }

      if (dryRun) {
        info(`dry-run: would have deleted the following tags: ${toDelete.length}`);
        for (const tag of toDelete) {
          info(`- ${tag.name}`);
        }
        return;
      }
      info(`delete the following tags: ${toDelete.length}`);
      for (const tag of toDelete) {
        info(`- ${tag.name}`);
        await client.deleteTag(tag.name);
      }
    } catch (e: unknown) {
      if (e instanceof Error) {
        info(`tag retention failed: ${e.message}`);
      }
    }
  } catch (e: unknown) {
    if (e instanceof Error) {
      setFailed(e.message);
    }
    setFailed('unknown error');
  }
}

dockerRegistryRetention();
