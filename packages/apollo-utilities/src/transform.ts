import {
  DocumentNode,
  SelectionNode,
  SelectionSetNode,
  OperationDefinitionNode,
  FieldNode,
  DirectiveNode,
  FragmentDefinitionNode,
  ArgumentNode,
  FragmentSpreadNode,
  VariableDefinitionNode,
  VariableNode,
} from 'graphql';
import { visit } from 'graphql/language/visitor';

import {
  checkDocument,
  getOperationDefinitionOrDie,
  getFragmentDefinitions,
  createFragmentMap,
  FragmentMap,
} from './getFromAST';
import { filterInPlace } from './util/filterInPlace';

export type RemoveNodeConfig<N> = {
  name?: string;
  test?: (node: N) => boolean;
  remove?: boolean;
};

export type GetNodeConfig<N> = {
  name?: string;
  test?: (node: N) => boolean;
};

export type RemoveDirectiveConfig = RemoveNodeConfig<DirectiveNode>;
export type GetDirectiveConfig = GetNodeConfig<DirectiveNode>;
export type RemoveArgumentsConfig = RemoveNodeConfig<ArgumentNode>;
export type GetFragmentSpreadConfig = GetNodeConfig<FragmentSpreadNode>;
export type RemoveFragmentSpreadConfig = RemoveNodeConfig<FragmentSpreadNode>;
export type RemoveFragmentDefinitionConfig = RemoveNodeConfig<
  FragmentDefinitionNode
>;
export type RemoveVariableDefinitionConfig = RemoveNodeConfig<
  VariableDefinitionNode
>;

const TYPENAME_FIELD: FieldNode = {
  kind: 'Field',
  name: {
    kind: 'Name',
    value: '__typename',
  },
};

function isEmpty(
  op: OperationDefinitionNode | FragmentDefinitionNode,
  fragments: FragmentMap,
): boolean {
  return op.selectionSet.selections.every(
    selection =>
      selection.kind === 'FragmentSpread' &&
      isEmpty(fragments[selection.name.value], fragments),
  );
}

function nullIfDocIsEmpty(doc: DocumentNode) {
  return isEmpty(
    getOperationDefinitionOrDie(doc),
    createFragmentMap(
      getFragmentDefinitions(doc)
    ),
  ) ? null : doc;
}

function getDirectiveMatcher(
  directives: (RemoveDirectiveConfig | GetDirectiveConfig)[],
) {
  return function directiveMatcher(directive: DirectiveNode) {
    return directives.some(
      dir =>
        (dir.name && dir.name === directive.name.value) ||
        (dir.test && dir.test(directive)),
    );
  };
}

export function removeDirectivesFromDocument(
  directives: RemoveDirectiveConfig[],
  doc: DocumentNode,
): DocumentNode | null {
  const variablesInUse: Record<string, boolean> = Object.create(null);
  let variablesToRemove: RemoveArgumentsConfig[] = [];

  const fragmentSpreadsInUse: Record<string, boolean> = Object.create(null);
  let fragmentSpreadsToRemove: RemoveFragmentSpreadConfig[] = [];

  let modifiedDoc = nullIfDocIsEmpty(visit(doc, {
    Variable: {
      enter(node, _key, parent) {
        // Store each variable that's referenced as part of an argument
        // (excluding operation definition variables), so we know which
        // variables are being used. If we later want to remove a variable
        // we'll fist check to see if it's being used, before continuing with
        // the removal.
        if ((parent as VariableDefinitionNode).kind !== 'VariableDefinition') {
          variablesInUse[node.name.value] = true;
        }
      },
    },

    Field: {
      enter(node) {
        // If `remove` is set to true for a directive, and a directive match
        // is found for a field, remove the field as well.
        const shouldRemoveField = directives.some(
          directive => directive.remove,
        );

        if (
          shouldRemoveField &&
          node.directives.some(getDirectiveMatcher(directives))
        ) {
          if (node.arguments) {
            // Store field argument variables so they can be removed
            // from the operation definition.
            node.arguments.forEach(arg => {
              if (arg.value.kind === 'Variable') {
                variablesToRemove.push({
                  name: (arg.value as VariableNode).name.value,
                });
              }
            });
          }

          if (node.selectionSet) {
            // Store fragment spread names so they can be removed from the
            // docuemnt.
            getAllFragmentSpreadsFromSelectionSet(node.selectionSet).forEach(
              frag => {
                fragmentSpreadsToRemove.push({
                  name: frag.name.value,
                });
              },
            );
          }

          // Remove the field.
          return null;
        }
      },
    },

    FragmentSpread: {
      enter(node) {
        // Keep track of referenced fragment spreads. This is used to
        // determine if top level fragment definitions should be removed.
        fragmentSpreadsInUse[node.name.value] = true;
      },
    },

    Directive: {
      enter(node) {
        // If a matching directive is found, remove it.
        if (getDirectiveMatcher(directives)(node)) {
          return null;
        }
      },
    },
  }));

  // If we've removed fields with arguments, make sure the associated
  // variables are also removed from the rest of the document, as long as they
  // aren't being used elsewhere.
  if (modifiedDoc &&
      filterInPlace(variablesToRemove, v => !variablesInUse[v.name]).length) {
    modifiedDoc = removeArgumentsFromDocument(variablesToRemove, modifiedDoc);
  }

  // If we've removed selection sets with fragment spreads, make sure the
  // associated fragment definitions are also removed from the rest of the
  // document, as long as they aren't being used elsewhere.
  if (modifiedDoc &&
      filterInPlace(
        fragmentSpreadsToRemove,
        fs => !fragmentSpreadsInUse[fs.name],
      ).length) {
    modifiedDoc = removeFragmentSpreadFromDocument(
      fragmentSpreadsToRemove,
      modifiedDoc,
    );
  }

  return modifiedDoc;
}

export function addTypenameToDocument(doc: DocumentNode): DocumentNode {
  return visit(checkDocument(doc), {
    SelectionSet: {
      enter(node, _key, parent) {
        // Don't add __typename to OperationDefinitions.
        if (
          parent &&
          (parent as OperationDefinitionNode).kind === 'OperationDefinition'
        ) {
          return;
        }

        // No changes if no selections.
        const { selections } = node;
        if (!selections) {
          return;
        }

        // If selections already have a __typename, or are part of an
        // introspection query, do nothing.
        const skip = selections.some(selection => {
          return (
            selection.kind === 'Field' &&
            ((selection as FieldNode).name.value === '__typename' ||
              (selection as FieldNode).name.value.lastIndexOf('__', 0) === 0)
          );
        });
        if (skip) {
          return;
        }

        // Create and return a new SelectionSet with a __typename Field.
        return {
          ...node,
          selections: [...selections, TYPENAME_FIELD],
        };
      },
    },
  });
}

const connectionRemoveConfig = {
  test: (directive: DirectiveNode) => {
    const willRemove = directive.name.value === 'connection';
    if (willRemove) {
      if (
        !directive.arguments ||
        !directive.arguments.some(arg => arg.name.value === 'key')
      ) {
        console.warn(
          'Removing an @connection directive even though it does not have a key. ' +
            'You may want to use the key parameter to specify a store key.',
        );
      }
    }

    return willRemove;
  },
};

export function removeConnectionDirectiveFromDocument(doc: DocumentNode) {
  return removeDirectivesFromDocument(
    [connectionRemoveConfig],
    checkDocument(doc),
  );
}

function hasDirectivesInSelectionSet(
  directives: GetDirectiveConfig[],
  selectionSet: SelectionSetNode,
  nestedCheck = true,
): boolean {
  return (
    selectionSet &&
    selectionSet.selections &&
    selectionSet.selections.some(selection =>
      hasDirectivesInSelection(directives, selection, nestedCheck),
    )
  );
}

function hasDirectivesInSelection(
  directives: GetDirectiveConfig[],
  selection: SelectionNode,
  nestedCheck = true,
): boolean {
  if (selection.kind !== 'Field' || !(selection as FieldNode)) {
    return true;
  }

  if (!selection.directives) {
    return false;
  }

  return (
    selection.directives.some(getDirectiveMatcher(directives)) ||
    (nestedCheck &&
      hasDirectivesInSelectionSet(
        directives,
        selection.selectionSet,
        nestedCheck,
      ))
  );
}

export function getDirectivesFromDocument(
  directives: GetDirectiveConfig[],
  doc: DocumentNode,
): DocumentNode {
  checkDocument(doc);

  let parentPath: string;

  return nullIfDocIsEmpty(visit(doc, {
    SelectionSet: {
      enter(node, _key, _parent, path) {
        const currentPath = path.join('-');

        if (
          !parentPath ||
          currentPath === parentPath ||
          !currentPath.startsWith(parentPath)
        ) {
          if (node.selections) {
            const selectionsWithDirectives = node.selections.filter(selection =>
              hasDirectivesInSelection(directives, selection),
            );

            if (hasDirectivesInSelectionSet(directives, node, false)) {
              parentPath = currentPath;
            }

            return {
              ...node,
              selections: selectionsWithDirectives,
            };
          } else {
            return null;
          }
        }
      },
    },
  }));
}

function getArgumentMatcher(config: RemoveArgumentsConfig[]) {
  return function argumentMatcher(argument: ArgumentNode) {
    return config.some(
      (aConfig: RemoveArgumentsConfig) =>
        argument.value &&
        argument.value.kind === 'Variable' &&
        argument.value.name &&
        (aConfig.name === argument.value.name.value ||
          (aConfig.test && aConfig.test(argument))),
    );
  };
}

export function removeArgumentsFromDocument(
  config: RemoveArgumentsConfig[],
  doc: DocumentNode,
): DocumentNode {
  const argMatcher = getArgumentMatcher(config);

  return nullIfDocIsEmpty(visit(doc, {
    OperationDefinition: {
      enter(node) {
        return {
          ...node,
          // Remove matching top level variables definitions.
          variableDefinitions: node.variableDefinitions.filter(
            varDef => !config.some(arg => arg.name === varDef.variable.name.value),
          ),
        };
      },
    },

    Field: {
      enter(node) {
        // If `remove` is set to true for an argument, and an argument match
        // is found for a field, remove the field as well.
        const shouldRemoveField = config.some(argConfig => argConfig.remove);

        if (shouldRemoveField) {
          let argMatchCount = 0;
          node.arguments.forEach(arg => {
            if (argMatcher(arg)) {
              argMatchCount += 1;
            }
          });
          if (argMatchCount === 1) {
            return null;
          }
        }
      },
    },

    Argument: {
      enter(node) {
        // Remove all matching arguments.
        if (argMatcher(node)) {
          return null;
        }
      },
    },
  }));
}

export function removeFragmentSpreadFromDocument(
  config: RemoveFragmentSpreadConfig[],
  doc: DocumentNode,
): DocumentNode {
  function enter(
    node: FragmentSpreadNode | FragmentDefinitionNode,
  ): null | void {
    if (config.some(def => def.name === node.name.value)) {
      return null;
    }
  }

  return nullIfDocIsEmpty(
    visit(doc, {
      FragmentSpread: { enter },
      FragmentDefinition: { enter },
    }),
  );
}

function getAllFragmentSpreadsFromSelectionSet(
  selectionSet: SelectionSetNode,
): FragmentSpreadNode[] {
  const allFragments: FragmentSpreadNode[] = [];

  selectionSet.selections.forEach(selection => {
    if ((selection.kind === 'Field' ||
         selection.kind === 'InlineFragment') &&
        selection.selectionSet) {
      getAllFragmentSpreadsFromSelectionSet(
        selection.selectionSet
      ).forEach(frag => allFragments.push(frag));
    } else if (selection.kind === 'FragmentSpread') {
      allFragments.push(selection);
    }
  });

  return allFragments;
}
