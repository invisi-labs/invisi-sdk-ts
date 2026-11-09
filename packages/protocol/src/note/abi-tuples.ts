export const singleTuple = [
    "(address token,bytes32 merkleRoot,bytes32[] nullifiers,bytes32[] outputCommitments,uint256 inputTreeId,address withdrawalAddress,uint256 withdrawalAmount,uint256 deadline,address feeRecipient,uint256 feeAmount)",
][0]!;

export const crossTuple = [
    "(address token,(uint256 treeId,bytes32 merkleRoot)[] sources,bytes32[] nullifiers,bytes32[] outputCommitments,address withdrawalAddress,uint256 withdrawalAmount,uint256 deadline,address feeRecipient,uint256 feeAmount)",
][0]!;
