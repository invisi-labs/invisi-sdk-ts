# 三SDK真实服务联调

仅在操作员自有的本地harness明确启用：

```sh
INVISI_PROVENANCE_LIVE=1 \
INVISI_PROVENANCE_TRUST=/path/to/owned-run/sdk-trust.json \
node scripts/provenance-live-all.mjs
```

wrapper依次运行TS `live.test.ts`、Go `TestProvenanceLiveService`和Rust `provenance_live`，不启动mock、不创建证明或提交新交易、不改App／钱包流程。没有显式开关时，专项测试不发送HTTP。wrapper同时要求开关与文件路径，防止把未执行的测试记作联调成功。

信任文件由运行中的本地harness从操作员配置生成，只含公开材料：`format: invisi-provenance-sdk-live-v1`、固定service origin `endpoint`、`scope`、`chainGeneration`、`providerId`、`initialSigningPublicKey/initialSigningKeyId`、`currentSigningPublicKey/currentSigningKeyId`、`manifestSha256`、`keyRotations`、`checkedAt`、已发布的`rootId`、该root包含的公开`commitment`及真实验证完成的`jobId`。不读取钱包fixture或opening。SDK测试自身固定reviewed manifest摘要，并验证genesis／current key ID及从外部固定genesis开始的轮换链；不以服务返回的公钥建立信任。

测试真实机器JSON-RPC的version/status/policy、根页和单根、公开叶子与本地深度32重建、本地commitment查找、显式同意后的远端成员路径对照、Note认可及真实native proof job的身份字段。另向同一真实服务请求数据并用错误provider、scope、generation、key和manifest固定值验证SDK拒绝；不发送私密材料。

服务与链必须在全部三SDK结束前保持运行且generation不变。共享读限流时先结束浏览器测试并等待窗口重置，再运行此wrapper；不要把限流错误当协议成功。harness可用`INVISI_PROVENANCE_LIVE_HOOK`在生成信任文件后执行wrapper，并传递上述环境。

结果写在信任文件同目录的`sdk-live-validation.json`；仅全部真实测试退出0才设置`complete:true`。它记录endpoint、scope、manifest、root/job定位和执行结果，不包含任何私钥／nonce／witness。最终真实运行证据应与harness的链／proof／服务报告一起保留，不能把默认未启用的测试输出当作实证。
