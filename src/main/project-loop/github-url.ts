export interface GitHubRepositoryRef {
  owner: string
  name: string
  slug: string
  url: string
}
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPOSITORY = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/

/** Parse only repository roots hosted on github.com. Branch, file and credential URLs are rejected. */
export function parseGitHubRepositoryUrl(input: string): GitHubRepositoryRef {
  const value = input.trim()
  if (!value || value.length > 2048) throw new Error('Enter a GitHub repository URL.')

  let owner = ''
  let name = ''
  const ssh = value.match(/^git@github\.com:([^/]+)\/([^/]+?)\/?$/i)
  if (ssh) {
    owner = ssh[1]
    name = ssh[2]
  } else {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new Error('Use a link such as https://github.com/owner/repository.')
    }
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('Only clean https://github.com repository links are supported.')
    }
    const parts = parsed.pathname.split('/').filter(Boolean)
    if (parts.length !== 2) throw new Error('Choose the repository root, not a branch or file link.')
    ;[owner, name] = parts
  }

  name = name.replace(/\.git$/i, '')
  if (!OWNER.test(owner) || !REPOSITORY.test(name)) throw new Error('This GitHub owner or repository name is not valid.')
  return { owner, name, slug: `${owner}/${name}`, url: `https://github.com/${owner}/${name}` }
}
