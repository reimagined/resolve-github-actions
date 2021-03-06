import * as path from 'path'
import * as core from '@actions/core'
import isEmpty from 'lodash.isempty'
import fs from 'fs'
import { promisify } from 'util'
import { getGit } from '../../common/src/git'
import { getDocker } from '../../common/src/docker'
import { branchFromRef, notEmpty, parseBoolean } from '../../common/src/utils'
import { PushEvent } from '../../common/src/types'
import { getOctokit } from '@actions/github'

const truncateFile = promisify(fs.truncate)
const readFile = promisify(fs.readFile)
const writeFile = promisify(fs.writeFile)

export const main = async (): Promise<void> => {
  core.debug(`parsing push event`)
  const event: PushEvent = JSON.parse(
    core.getInput(`push_event`, { required: true })
  )

  const commitMessage = core.getInput('commit_message')
  if (event.head_commit.message === commitMessage) {
    core.warning(
      `Skipping own commit because of message "${commitMessage}". There will be more efficient to add workflow condition!`
    )
    return
  }

  core.info('preparing to generate changelog')

  core.debug(`acquiring Git CLI`)
  const git = getGit(path.resolve('./'), core.getInput('ssh_private_key'), core)

  const token = core.getInput('token', { required: true })
  const releaseTag = core.getInput('release_tag')
  const upcoming = parseBoolean(core.getInput('upcoming'))

  if (upcoming) {
    core.startGroup('configuring git')
    core.debug(`requesting PAT user info`)
    const octokit = getOctokit(token)
    const {
      data: { login: name, email },
    } = await octokit.users.getAuthenticated()
    if (isEmpty(email)) {
      throw Error(
        `cannot retrieve user ${name} email with provided PAT, check GitHub account email privacy settings`
      )
    }

    core.info(`user.email: ${email}`)
    git(`config --global user.email ${email}`)

    core.info(`user.name: ${name}`)
    git(`config --global user.name ${name}`)
    core.endGroup()

    core.startGroup('preparing repository')
    core.debug(`cloning repo ${event.repository.ssh_url}`)
    git(`clone ${event.repository.ssh_url} ./`)

    core.debug(`determining branch from ref: ${event.ref}`)
    const branch = branchFromRef(event.ref)

    core.debug(`checking out branch: ${branch}`)
    git(`checkout ${branch}`)

    core.debug(`resetting branch to push commit: ${event.head_commit.id}`)
    git(`reset --hard ${event.head_commit.id}`)

    core.endGroup()
  }

  core.startGroup('GitHub changelog generator')
  core.debug(`acquiring Docker`)
  const docker = getDocker(
    `githubchangeloggenerator/github-changelog-generator:${core.getInput(
      'generator_version'
    )}`
  )
  core.debug(`executing generator Docker image`)
  try {
    const args = [
      `--token=${token}`,
      `--user=${event.repository.owner.name}`,
      `--project=${event.repository.name}`,
      `--unreleased`,
      `--unreleased-only`,
      notEmpty(releaseTag) ? `--future-release=${releaseTag}` : '',
    ].join(' ')

    await docker.run({
      mounts: [
        {
          host: process.cwd(),
          container: '/usr/local/src/your-app',
        },
      ],
      args,
      debug: core.debug,
      error: core.error,
    })
  } catch (e) {
    core.error(e)
  }

  if (!upcoming) {
    core.debug(`replacing HISTORY.md`)
    const historyFile = 'HISTORY.md'
    const changelogFile = 'CHANGELOG.md'

    core.debug(`reading changelog`)
    const changelog = (await readFile(changelogFile)).toString()

    core.debug(`truncating changelog`)
    await truncateFile(historyFile)

    core.debug(`writing history`)
    await writeFile(historyFile, changelog)

    core.debug(`HISTORY.md updated`)
  }
  core.endGroup()

  core.startGroup(`Committing and pushing changes`)
  try {
    git(`add -u`)
    git(`commit -m "${commitMessage}"`)
    git(`push`)
  } catch (e) {
    core.error(e)
  } finally {
    core.endGroup()
  }
}
