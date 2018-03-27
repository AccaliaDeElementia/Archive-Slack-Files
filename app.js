#!/usr/bin/env node

const yargs = require('yargs');
const request = require('request');

const fs = require('fs-extra');
const path = require('path');


const makePromiseRequest = (config) => new Promise((resolve, reject) => {
        return request(config, (err, _, res) => {
            if (err) {
                return reject(err);
            }
            resolve(res);
        });
    })
    .then(data => JSON.parse(data));

const getChannels = () => makePromiseRequest({
        method: 'POST',
        url: 'https://slack.com/api/channels.list',
        formData: {
            token: args.token,
            exclude_members: 'true',
            count: 500
        }
    })
    .then(data => {
        const res = {};
        data.channels.forEach(entry => res[entry.id] = entry.name);
        return res;
    });

const getUsers = () => makePromiseRequest({
        method: 'POST',
        url: 'https://slack.com/api/users.list',
        formData: {
            token: args.token,
            count: 500
        }
    })
    .then(data => {
        const res = {};
        data.members.forEach(entry => res[entry.id] = entry.name);
        return res;
    });

const getFiles = (users, channels) => {
    let maxPages = 1;
    const getem = (page) => makePromiseRequest({
        method: 'POST',
        url: 'https://slack.com/api/files.list',
        formData: {
            token: args.token,
            ts_from: 0,
            ts_to: Math.floor(Date.now() / 1000) - args.cutoffDays * 24 * 60 * 60,
            count: 50,
            page
        }
    })
    .then(data => {
        maxPages = data.paging.pages;
        return data;
    })
    .then(data => data.files
        .filter(file => file.channels[0])
        .map(record => {
            return {
                filename: `${new Date(record.timestamp * 1000).toISOString().slice(0,-5)} - ${users[record.user]} - ${record.name}`.replace(/[\/\\:]/g, '_'),
                folder: channels[record.channels[0]],
                permalink: record.url_private_download,
                id: record.id,
            };
        })
        .filter(file => file.permalink));
    const getUntil = (i, results, count) => {
	console.log(`Fetching page ${i} with ${results.length} candidates so far`);
        return getem(i).then(files => {
            results = results.concat(files);
            if (results.length >= count || i >= maxPages) {
                return Promise.resolve(results);
            }
            return getUntil(i + 1, results, count);
        });
    };
    return getUntil(1, [], 50);
};

const deleteFile = file => {
    const folder = path.join(args.destination, file.folder);
    const dest = path.join(folder, file.filename);
    console.log(`Downloading \`${file.filename}\` from \`${file.folder}\``);
    if (!args.runDelete) {
        return Promise.resolve();
    }
    return fs.ensureDir(folder)
        .then(() => new Promise((res, rej) => {
            request({
                    url: file.permalink,
                    headers: {
                        Authorization: `Bearer ${args.token}`
                    }
                })
                .pipe(fs.createWriteStream(dest))
                .on('error', (err) => rej(err))
                .on('close', res());
        }))
        .then(() => console.log('Download complete!'))
        .then(() => makePromiseRequest({
            method: 'POST',
            url: 'https://slack.com/api/files.delete',
            formData: {
                token: args.token,
                file: file.id
            }
        }));
};

const deleteFiles = files => {
    const _files = files.slice();
    const next = () => {
        const file = _files.pop();
        if (!file) {
            return Promise.resolve();
        }
        return deleteFile(file).then(next);
    };
    return next().catch(e => console.error(`Whoopsie! ${e.message}`));
};

const args = yargs
    .describe('token', 'Slack API token for authentication')
    .default('token', process.env.SLACK_TOKEN)
    .describe('dry-run', 'Perform a dry run')
    .describe('run-delete', 'Download and delete files from Slack')
    .conflicts('dry-run', 'run-delete')
    .alias('destination', 'dest')
    .describe('destination', 'Download File Destination')
    .default('destination', '.')
    .coerce('destination', path.resolve)
    .describe('cutoff-days', 'Number of days to preserve files for')
    .default('cutoff-days', 120)
    .number('cutoff-days')
    .argv;

Promise.all([getUsers(), getChannels()])
    .then(([users, channels]) => getFiles(users, channels))
    .then(deleteFiles)
    .then(() => console.log('DONE'));
