import { ChildProcess, exec } from 'child_process'
import omit from 'lodash.omit'
import { unlinkSync, copyFileSync } from 'fs'
import { URL } from 'url'
import * as core from '@actions/core'
import { mocked } from 'ts-jest/utils'
import { unpublish } from '../src/unpublish'
import { post } from '../src/post'
import {
  processWorkspaces,
  WorkspaceProcessor,
  writeNpmRc,
  restoreNpmRc,
} from '../../common/src/utils'

jest.mock('../src/unpublish')
jest.mock('../../common/src/utils')
jest.mock('@actions/core')
jest.mock('child_process')
jest.mock('fs')

const mExec = mocked(exec)
const mUnpublish = mocked(unpublish)
const mCoreGetState = mocked(core.getState)
const mCoreGetInput = mocked(core.getInput)
const mCoreDebug = mocked(core.debug)
const mUnlink = mocked(unlinkSync)
const mCopyFile = mocked(copyFileSync)
const mProcessWorkspaces = mocked(processWorkspaces)
const mWriteNpmRc = mocked(writeNpmRc)
const mRestoreNpmRc = mocked(restoreNpmRc)

let originalArgv = process.argv
let jobState: { [key: string]: string }
let actionInput: { [key: string]: string }

beforeEach(() => {
  jobState = {
    version: '1.2.3',
    npmrc_path: 'npm-rc-file',
    registry_url: 'https://registry.com',
    registry_token: 'registry-token',
  }
  actionInput = {
    unpublish: 'yes',
  }

  mCoreGetState.mockImplementation((name) => jobState[name])
  mCoreGetInput.mockImplementation((name) => actionInput[name])
  mExec.mockImplementation((command, options, callback) => {
    callback?.(null, 'executed', '')
    return {} as ChildProcess
  })
})

afterEach(() => {
  process.argv = originalArgv
})

test('unpublish command does not invoked if no workspace provided', async () => {
  process.argv = ['node', 'index.js']

  await post()

  expect(mUnpublish).not.toHaveBeenCalled()
})

test('throw error if no version within job state', async () => {
  jobState.version = ''

  await expect(post()).rejects.toBeInstanceOf(Error)
})

test('workspace processor', async () => {
  process.argv = ['node', 'index.js']

  await post()

  expect(mProcessWorkspaces).toHaveBeenCalled()
  const processor: WorkspaceProcessor<unknown> =
    mProcessWorkspaces.mock.calls[0][0]

  await processor({
    name: 'mock-package',
    location: '/path/to/package',
    pkg: {
      name: 'mock-package',
      version: '1.0.0',
    },
  })

  expect(mExec).not.toHaveBeenCalled()
  expect(mUnpublish).toHaveBeenCalledWith('1.2.3', '/path/to/package')
})

test('workspace processor failure', async () => {
  await post()

  expect(mProcessWorkspaces).toHaveBeenCalled()
  const processor: WorkspaceProcessor<unknown> =
    mProcessWorkspaces.mock.calls[0][0]

  mUnpublish.mockImplementationOnce(() => {
    throw Error('failure')
  })

  await expect(
    processor({
      name: 'mock-package',
      location: '/path/to/package',
      pkg: {
        name: 'mock-package',
        version: '1.0.0',
      },
    })
  ).rejects.toBeInstanceOf(Error)
})

test('workspace processor skip debug output of stdout if its empty', async () => {
  await post()

  const processor: WorkspaceProcessor<unknown> =
    mProcessWorkspaces.mock.calls[0][0]

  mExec.mockImplementationOnce((command, options, callback) => {
    callback?.(null, '', '')
    return {} as ChildProcess
  })

  mCoreDebug.mockClear()

  await processor({
    name: 'mock-package',
    location: '/path/to/package',
    pkg: {
      name: 'mock-package',
      version: '1.0.0',
    },
  })

  expect(mCoreDebug).not.toHaveBeenCalledWith('')
})

test('do not unpublish if "unpublish" input does not set to positive value', async () => {
  actionInput.unpublish = 'false'

  await post()

  expect(mProcessWorkspaces).not.toHaveBeenCalled()
})

test('npmrc file written', async () => {
  await post()

  expect(mWriteNpmRc).toHaveBeenCalledWith(
    'npm-rc-file',
    new URL('https://registry.com'),
    'registry-token',
    expect.objectContaining({ createBackup: true })
  )
})

test('npmrc file removed and restored from backup', async () => {
  mWriteNpmRc.mockReturnValueOnce('npm-rc-backup')

  await post()

  expect(mRestoreNpmRc).toHaveBeenCalledWith(
    'npm-rc-file',
    `npm-rc-backup`,
    expect.anything()
  )
})

test('skip npmrc writing/restoring if no registry within state', async () => {
  jobState = omit(jobState, 'registry_url')

  await post()

  expect(mWriteNpmRc).not.toHaveBeenCalled()
  expect(mRestoreNpmRc).not.toHaveBeenCalled()
})

test('skip restore from backup if no backup file within state', async () => {
  jobState.npmrc_backup = ''

  await post()

  expect(mCopyFile).not.toHaveBeenCalled()
})

test('skip npmrc file remove if no file name within state', async () => {
  jobState.npmrc_file = ''

  await post()

  expect(mUnlink).not.toHaveBeenCalled()
})
