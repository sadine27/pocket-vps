# patch-gguf.py — add new-format bert.* metadata keys to an old BERT GGUF
# llama.cpp (2025+) requires bert.context_length / bert.pooling_type /
# bert.attention.causal etc.; 2024-era BERT GGUFs only have the old names.
# Usage: python3 patch-gguf.py <input.gguf> <output.gguf>
# The original file is left untouched (we patch a byte copy).
import sys, shutil

try:
    from gguf import GGUFReader, GGUFValue, GGUFValueType
except ImportError:
    from gguf.gguf_reader import GGUFReader, GGUFValue
    from gguf.constants import GGUFValueType

src, dst = sys.argv[1], sys.argv[2]
shutil.copyfile(src, dst)
r = GGUFReader(dst, 'r+')

old = {}
for name, f in r.fields.items():
    if name.startswith('bert.'):
        old[name] = f

def val(name, default):
    f = old.get(name)
    try:
        return f.contents() if f else default
    except Exception:
        return default

r.fields['bert.context_length'] = GGUFValue(GGUFValueType.UINT32, int(val('bert.max_position_embeddings', 512)))
r.fields['bert.embedding_length'] = GGUFValue(GGUFValueType.UINT32, int(val('bert.output_dim', 384)))
r.fields['bert.pooling_type'] = GGUFValue(GGUFValueType.UINT32, 1)  # MEAN = sentence-transformers default
r.fields['bert.attention.causal'] = GGUFValue(GGUFValueType.BOOL, False)
r.fields['bert.attention.layer_norm_epsilon'] = GGUFValue(GGUFValueType.FLOAT32, float(val('bert.layer_norm_eps', 1e-12)))

r.save()
print('patched ->', dst)
print('bert keys now:', sorted(k for k in r.fields if k.startswith('bert.')))
