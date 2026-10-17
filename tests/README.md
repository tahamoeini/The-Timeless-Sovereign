# Validation

Run the core integrity suite with:

```powershell
python -m unittest discover -s tests\unit -v
```

The suite uses synthetic story data, including Aria, Kael, a secret, evidence, and an isolated scenario branch. Add negative and recovery cases beside each newly implemented contract. End-to-end and bilingual quality evaluation remain pending; see [the acceptance matrix](../docs/ACCEPTANCE_MATRIX.md).
