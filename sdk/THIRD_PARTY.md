# Compiler provenance and licensing

QuickGUI's engine, C worker, SDK and scripts here are original implementation;
they do not incorporate z8run or Penpot source code.

The optional development compiler is TinyCC upstream revision
`e23dabed154a8495f3ac1ff3cc9d04fa1c207893` from
`https://github.com/TinyCC/tinycc`. The setup script downloads its original archive
and preserves `COPYING` in `.toolchain/licenses/TinyCC-COPYING`, plus the complete
upstream source under `.toolchain/src`. TinyCC's upstream licensing includes the
LGPL; runtime support and individual files may carry additional notices. Review
and retain the actual pinned source notices when distributing a compiler or
runtime support library. The toolchain is not committed into this source tree.

Source distributions that include compiler changes must preserve applicable
notices and include those modifications and rebuild instructions. AOT export
uses the user's platform C toolchain and does not bundle libtcc by default.
Rust/npm dependencies retain their own licenses; their versions are recorded by
the workspace lockfiles, which should accompany source exports.
