export type GitVerb = "pull" | "push" | "fetch" | "merge" | "rebase" | "continue";

export type GitProblemKind =
  | "diverged"
  | "pushRejected"
  | "remoteRejected"
  | "dirty"
  | "conflict"
  | "inProgress"
  | "auth"
  | "network"
  | "noRemote"
  | "noUpstream"
  | "remoteMissing"
  | "locked"
  | "unknown";

export type GitProblem = {
  kind: GitProblemKind;
  title: string;
  hint: string;
  files?: string[];
};

const VERB_NAME: Record<GitVerb, string> = { pull: "Pull", push: "Push", fetch: "Fetch", merge: "Merge", rebase: "Rebase", continue: "Continue" };

export function classifyGitFailure(output: string, verb: GitVerb, context: { branch?: string | null } = {}): GitProblem {
  const text = output;
  if (/^CONFLICT \(|Automatic merge failed|Resolve all conflicts manually|could not apply [0-9a-f]+|When you have resolved this problem/m.test(text)) {
    const what = verb === "rebase" || /could not apply|rebase --continue/i.test(text) ? "Rebase" : "Merge";
    return { kind: "conflict", title: `${what} stopped because of conflicts`, hint: "Open the files under Merge Changes, choose which side to keep, then mark them resolved and continue." };
  }
  if (/Not possible to fast-forward|Need to specify how to reconcile divergent branches|divergent branches/i.test(text)) {
    return { kind: "diverged", title: "Your branch and its remote have diverged", hint: "Each side has commits the other does not. Merge or rebase to bring them together." };
  }
  if (/! \[(?:remote )?rejected\]/.test(text) && /non-fast-forward|fetch first|stale info|behind its remote/i.test(text)) {
    return { kind: "pushRejected", title: "The remote has commits you do not have", hint: "Pull them in first, then push again." };
  }
  if (/Updates were rejected because the (?:tip of your current branch is behind|remote contains work)/i.test(text)) {
    return { kind: "pushRejected", title: "The remote has commits you do not have", hint: "Pull them in first, then push again." };
  }
  if (/remote rejected|pre-receive hook declined|protected branch|GH006|refusing to allow/i.test(text) && verb === "push") {
    const reason = firstUseful(text.split("\n").filter((line) => /remote rejected|declined|protected|GH006|refusing/i.test(line)));
    return { kind: "remoteRejected", title: "The remote refused the push", hint: reason || "The remote has a rule this push does not meet." };
  }
  if (/You have not concluded your merge|rebase-merge directory|rebase-apply directory|is not possible because you have unmerged files|Pulling is not possible because you have unmerged files|You are in the middle of/i.test(text)) {
    return { kind: "inProgress", title: "A merge or rebase is already in progress", hint: "Finish it or abort it from Source Control, then try again." };
  }
  if (/Your local changes to the following files would be overwritten|Please,? commit your changes or stash them|Cannot pull with rebase: You have unstaged changes|cannot (?:pull|rebase|merge) with rebase|You have unstaged changes|untracked working tree files would be overwritten|Please move or remove them before you merge/i.test(text)) {
    return { kind: "dirty", title: "Your local changes are in the way", hint: "Commit or discard the changes to these files, then try again.", files: listedFiles(text) };
  }
  if (/Another git process seems to be running|Unable to create '.*\.lock'|If no other git process is currently running/i.test(text)) {
    return { kind: "locked", title: "Another git process is running", hint: "Wait for it to finish. If none is running, delete the .lock file git named." };
  }
  if (/Authentication failed|Permission denied \((?:publickey|keyboard-interactive)|terminal prompts disabled|could not read (?:Username|Password)|invalid username or password|Host key verification failed|HTTP Basic: Access denied/i.test(text)) {
    return { kind: "auth", title: "Git could not sign in to the remote", hint: "Check the credentials or SSH key this repository uses. Running git fetch in a terminal shows the prompt." };
  }
  if (/No remote repository specified|No such remote|No configured push destination/i.test(text)) {
    return { kind: "noRemote", title: "This repository has no remote to use", hint: "Add one with git remote add origin <url>." };
  }
  if (/has no upstream branch|There is no tracking information for the current branch|no tracking information|You asked to pull from the remote .*, but did not specify a branch/i.test(text)) {
    const branch = context.branch ?? /current branch (\S+) has no upstream/.exec(text)?.[1];
    return { kind: "noUpstream", title: "This branch has no upstream branch", hint: branch ? `Publish it from a terminal with git push -u origin ${branch}.` : "Publish it from a terminal with git push -u origin <branch>." };
  }
  if (/Repository not found|couldn't find remote ref|does not exist or you do not have access|remote: Not Found|does not appear to be a git repository/i.test(text)) {
    return { kind: "remoteMissing", title: "The remote repository or branch was not found", hint: "Check the remote address and that the branch exists there." };
  }
  if (/Could not resolve host|Could not read from remote repository|unable to access|Connection (?:timed out|refused|reset)|Network is unreachable|early EOF|The remote end hung up|Failed to connect/i.test(text)) {
    return { kind: "network", title: "Could not reach the remote", hint: "Check your network connection and the remote address, then try again." };
  }
  return { kind: "unknown", title: `${VERB_NAME[verb]} failed`, hint: firstUseful(text.split("\n")) || "Git did not give a reason." };
}

function firstUseful(lines: string[]): string {
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^Command failed:/.test(line) || /^hint:/i.test(line) || /^From /.test(line) || /^remote:\s*$/.test(line)) continue;
    return line.replace(/^(?:fatal|error|remote):\s*/i, "");
  }
  return "";
}

function listedFiles(text: string): string[] {
  const files: string[] = [];
  for (const line of text.split("\n")) {
    const found = /^\t(\S.*)$/.exec(line);
    if (found) files.push(found[1].trim());
    else if (files.length > 0) break;
  }
  return files.slice(0, 5);
}
