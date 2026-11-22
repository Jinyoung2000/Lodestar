import { classifyGitFailure } from "../shared/gitProblems";

const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const kind = (output: string, verb: Parameters<typeof classifyGitFailure>[1] = "pull") => classifyGitFailure(output, verb).kind;

expect(kind("Command failed: git pull --ff-only\nhint: Diverging branches can't be fast-forwarded, you need to either:\nfatal: Not possible to fast-forward, aborting.") === "diverged", "ff-only diverged");
expect(kind("fatal: Need to specify how to reconcile divergent branches.") === "diverged", "need to reconcile");

const rejected = "To /tmp/remote.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to '/tmp/remote.git'\nhint: Updates were rejected because the remote contains work that you do not\nhint: have locally.";
expect(kind(rejected, "push") === "pushRejected", "push rejected fetch first");
expect(kind(" ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push", "push") === "pushRejected", "push rejected non-ff");
expect(kind("remote: error: GH006: Protected branch update failed for refs/heads/main.\n ! [remote rejected] main -> main (protected branch hook declined)", "push") === "remoteRejected", "protected branch");

const dirty = "error: Your local changes to the following files would be overwritten by merge:\n\tmath.ts\n\tsrc/a b.ts\nPlease commit your changes or stash them before you merge.\nAborting";
const dirtyProblem = classifyGitFailure(dirty, "merge");
expect(dirtyProblem.kind === "dirty" && dirtyProblem.files?.join("|") === "math.ts|src/a b.ts", `dirty files ${dirtyProblem.files}`);
expect(kind("error: cannot pull with rebase: You have unstaged changes.\nerror: Please commit or stash them.") === "dirty", "rebase unstaged");
expect(kind("error: The following untracked working tree files would be overwritten by merge:\n\tx.txt\nPlease move or remove them before you merge.") === "dirty", "untracked overwritten");

expect(kind("Auto-merging math.ts\nCONFLICT (content): Merge conflict in math.ts\nAutomatic merge failed; fix conflicts and then commit the result.", "merge") === "conflict", "merge conflict");
expect(classifyGitFailure("CONFLICT (content): Merge conflict in a\nerror: could not apply 1a2b3c4... edit\nhint: Resolve all conflicts manually", "rebase").title.startsWith("Rebase"), "rebase conflict title");
expect(kind("CONFLICT (modify/delete): a deleted in HEAD\nAutomatic merge failed; fix conflicts\nNot possible to fast-forward") === "conflict", "conflict wins");

expect(kind("error: You have not concluded your merge (MERGE_HEAD exists).\nhint: Please, commit your changes before merging.\nfatal: Exiting because of unfinished merge.") === "inProgress", "unfinished merge");
expect(kind("fatal: It seems that there is already a rebase-merge directory, and\nI wonder if you are in the middle of another rebase.") === "inProgress", "rebase-merge directory");
expect(kind("error: Pulling is not possible because you have unmerged files.") === "inProgress", "unmerged files");

expect(kind("remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/x/y.git/'", "fetch") === "auth", "auth failed");
expect(kind("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", "fetch") === "auth", "ssh publickey");
expect(kind("fatal: could not read Username for 'https://github.com': terminal prompts disabled", "fetch") === "auth", "prompts disabled");
expect(kind("fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com", "fetch") === "network", "dns");
expect(kind("ssh: connect to host github.com port 22: Connection timed out\nfatal: Could not read from remote repository.", "fetch") === "network", "timeout");
expect(kind("fatal: '/nowhere/remote.git' does not appear to be a git repository\nfatal: Could not read from remote repository.", "fetch") === "remoteMissing", "bad path");
expect(kind("ERROR: Repository not found.\nfatal: Could not read from remote repository.", "fetch") === "remoteMissing", "repo not found");
expect(kind("fatal: No configured push destination.\nEither specify the URL from the command-line or configure a remote repository using", "push") === "noRemote", "no push destination");
expect(kind("fatal: No remote repository specified.  Please, specify either a URL or a\nremote name from which new revisions should be fetched.") === "noRemote", "no remote specified");

const noUpstream = classifyGitFailure("fatal: The current branch topic has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream origin topic", "push");
expect(noUpstream.kind === "noUpstream" && noUpstream.hint.includes("git push -u origin topic"), `no upstream push: ${noUpstream.hint}`);
expect(kind("There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.") === "noUpstream", "no tracking information");
expect(classifyGitFailure("There is no tracking information for the current branch.", "pull", { branch: "feat/x" }).hint.includes("origin feat/x"), "branch from context");

expect(kind("fatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository") === "locked", "index.lock");

const unknown = classifyGitFailure("Command failed: git pull\nfatal: something odd happened", "pull");
expect(unknown.kind === "unknown" && unknown.title === "Pull failed" && unknown.hint === "something odd happened", `unknown ${JSON.stringify(unknown)}`);
expect(classifyGitFailure("", "push").hint === "Git did not give a reason.", "empty output");

console.log("gitproblems.test.ts 통과");
