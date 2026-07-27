export interface WorkspaceTreeNode {
  name: string
  path: string
  file: boolean
  children: WorkspaceTreeNode[]
}

export interface WorkspaceFileTreeIndex {
  tree: WorkspaceTreeNode[]
  directories: Set<string>
}

/**
 * Builds a directory tree in one pass over the path segments. The path map avoids
 * scanning every sibling for every segment in large repositories.
 */
export function buildWorkspaceFileTree(paths: string[]): WorkspaceFileTreeIndex {
  const root: WorkspaceTreeNode = { name: '', path: '', file: false, children: [] }
  const nodesByPath = new Map<string, WorkspaceTreeNode>([['', root]])
  const directories = new Set<string>()

  for (const path of paths) {
    const parts = path.split('/').filter(Boolean)
    let parent = root
    let nodePath = ''

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]
      nodePath = nodePath ? `${nodePath}/${part}` : part
      let node = nodesByPath.get(nodePath)
      if (!node) {
        node = {
          name: part,
          path: nodePath,
          file: index === parts.length - 1,
          children: []
        }
        nodesByPath.set(nodePath, node)
        parent.children.push(node)
      }
      if (!node.file) directories.add(nodePath)
      parent = node
    }
  }

  const sort = (nodes: WorkspaceTreeNode[]): WorkspaceTreeNode[] => {
    nodes.sort((left, right) => Number(left.file) - Number(right.file) || left.name.localeCompare(right.name))
    for (const node of nodes) sort(node.children)
    return nodes
  }

  return { tree: sort(root.children), directories }
}
